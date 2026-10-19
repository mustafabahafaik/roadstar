// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title RacePool — giriş ücreti havuzu: para kontratta kilitli kalır, imzalı sıralamaya göre dağıtılır
/// @notice Yarışı zincir göremez; kimin kaçıncı olduğunu oyun sunucusu söyler ve İMZALAR.
///         Kontrat sadece imzanın resultSigner'dan geldiğini ve sıralamanın geçerli olduğunu kontrol eder.
///         Ödeme "pull" ile: settle sadece alacakları yazar, herkes kendi parasını withdraw() ile çeker.
contract RacePool {
    uint256 public constant MIN_PLAYERS = 2;
    uint256 public constant MAX_PLAYERS = 5;
    uint256 public constant JOIN_WINDOW = 10 minutes; // oda bu sürede dolmazsa iade açılır
    uint256 public constant SETTLE_WINDOW = 1 days; // başlamış oda bu sürede sonuçlanmazsa iade açılır (sunucu çökerse para kilitli kalmasın)
    uint256 public constant FIRST_SHARE = 80; // yüzde
    uint256 public constant SECOND_SHARE = 15; // yüzde. Kalan %5 (+ bölmeden artan kuruşlar) treasury'ye

    struct Room {
        // 1. depolama yuvası (16 + 8 + 8 = 32 bayt)
        uint128 entryFee; // wei
        uint64 createdAt; // oluşturulduğu blok zamanı (0 = böyle bir oda yok)
        uint64 startedAt; // dolduğu an (0 = henüz dolmadı)
        // 2. yuva
        uint8 maxPlayers;
        bool settled; // ödüller dağıtıldı mı
        // 3. yuva: dinamik dizi
        address[] players; // katılma sırasıyla
    }

    /// @notice Sıralamayı imzalayan sunucu adresi. Değiştirilemez: sahte bir imzacıya devredilemez
    address public immutable resultSigner;
    /// @notice %5 payın gittiği adres
    address public immutable treasury;

    uint256 public roomCount;
    mapping(uint256 roomId => Room) internal rooms;
    mapping(uint256 roomId => mapping(address player => bool)) public joined;
    /// @notice Kimin kontrattan ne kadar alacağı var (withdraw ile çekilir)
    mapping(address account => uint256) public claimable;

    // --- Olaylar ---
    event RoomCreated(uint256 indexed roomId, address indexed creator, uint256 entryFee, uint8 maxPlayers);
    event PlayerJoined(uint256 indexed roomId, address indexed player);
    event RoomStarted(uint256 indexed roomId);
    event RoomSettled(uint256 indexed roomId, address indexed first, address indexed second, uint256 pot);
    event Refunded(uint256 indexed roomId, address indexed player, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);

    // --- Hatalar ---
    error BadPlayerCount(uint8 maxPlayers);
    error BadEntryFee();
    error RoomNotFound(uint256 roomId);
    error RoomAlreadyStarted(uint256 roomId);
    error JoinWindowClosed(uint256 roomId);
    error WrongFee(uint256 sent, uint256 expected);
    error AlreadyJoined(uint256 roomId, address player);
    error RoomNotStarted(uint256 roomId);
    error AlreadySettled(uint256 roomId);
    error BadRankingLength(uint256 length, uint256 expected);
    error NotInRoom(uint256 roomId, address player);
    error DuplicatePlayer(address player);
    error InvalidSignature();
    error RefundNotAvailable(uint256 roomId);
    error NothingToWithdraw();
    error TransferFailed();
    error ZeroAddress();

    constructor(address resultSigner_, address treasury_) {
        // 0x0 imzacı ya da treasury: imzalar asla doğrulanmaz / %5 pay sonsuza dek çekilemez
        if (resultSigner_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        resultSigner = resultSigner_;
        treasury = treasury_;
    }

    // =========================================================================
    // Oda kurma ve katılma
    // =========================================================================

    /// @notice Yeni oda aç. Kurucu otomatik katılmaz: o da joinRoom ile ücretini yatırır
    function createRoom(uint256 entryFee, uint8 maxPlayers) external returns (uint256 roomId) {
        if (maxPlayers < MIN_PLAYERS || maxPlayers > MAX_PLAYERS) revert BadPlayerCount(maxPlayers);
        if (entryFee == 0 || entryFee > type(uint128).max) revert BadEntryFee();
        roomId = ++roomCount;
        Room storage r = rooms[roomId];
        r.entryFee = uint128(entryFee);
        r.createdAt = uint64(block.timestamp);
        r.maxPlayers = maxPlayers;
        emit RoomCreated(roomId, msg.sender, entryFee, maxPlayers);
    }

    /// @notice Ücreti tam yatırarak odaya gir. Son kişi girince oda "başladı" sayılır
    function joinRoom(uint256 roomId) external payable {
        Room storage r = rooms[roomId];
        if (r.createdAt == 0) revert RoomNotFound(roomId);
        if (r.startedAt != 0) revert RoomAlreadyStarted(roomId);
        if (block.timestamp >= r.createdAt + JOIN_WINDOW) revert JoinWindowClosed(roomId); // iade başladıysa giriş yok
        if (msg.value != r.entryFee) revert WrongFee(msg.value, r.entryFee);
        if (joined[roomId][msg.sender]) revert AlreadyJoined(roomId, msg.sender);

        joined[roomId][msg.sender] = true;
        r.players.push(msg.sender);
        emit PlayerJoined(roomId, msg.sender);

        if (r.players.length == r.maxPlayers) {
            r.startedAt = uint64(block.timestamp);
            emit RoomStarted(roomId);
        }
    }

    // =========================================================================
    // Sonuç: imzalı sıralama → alacaklar
    // =========================================================================

    /// @notice Sunucunun imzaladığı özet. Zincir ve kontrat adresi dahil → imza başka yerde tekrar kullanılamaz
    function resultHash(uint256 roomId, address[] calldata ranking) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), roomId, ranking));
    }

    /// @notice Sıralamayı zincire yaz ve ödülleri alacak olarak kaydet. Herkes çağırabilir: imza yetki verir
    /// @param ranking 1., 2., 3.... oyuncu adresleri (odadakilerin tekrarsız tam listesi; DNF'ler sonda)
    /// @param signature resultSigner'ın resultHash için signMessage imzası (65 bayt)
    function settle(uint256 roomId, address[] calldata ranking, bytes calldata signature) external {
        // 1) Kontroller
        Room storage r = rooms[roomId];
        if (r.startedAt == 0) revert RoomNotStarted(roomId);
        if (r.settled) revert AlreadySettled(roomId);
        uint256 count = r.players.length;
        if (ranking.length != count) revert BadRankingLength(ranking.length, count);
        // Permütasyon kontrolü: uzunluk aynı + herkes odada + kimse iki kez yok → odadakilerin tam listesi
        for (uint256 i = 0; i < count; i++) {
            if (!joined[roomId][ranking[i]]) revert NotInRoom(roomId, ranking[i]);
            for (uint256 j = 0; j < i; j++) {
                if (ranking[j] == ranking[i]) revert DuplicatePlayer(ranking[i]);
            }
        }
        // İmza: signMessage önüne "\x19Ethereum Signed Message:\n32" ekler; aynısını yapıp imzacıyı geri buluruz
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(resultHash(roomId, ranking));
        if (ECDSA.recover(digest, signature) != resultSigner) revert InvalidSignature();

        // 2) Durum: önce "dağıtıldı" işareti, sonra alacaklar. Para burada GÖNDERİLMEZ (pull)
        r.settled = true;
        uint256 pot = uint256(r.entryFee) * count;
        uint256 first = (pot * FIRST_SHARE) / 100;
        uint256 second = (pot * SECOND_SHARE) / 100;
        claimable[ranking[0]] += first;
        claimable[ranking[1]] += second;
        claimable[treasury] += pot - first - second; // %5 + yuvarlama artığı: toplam her zaman pot'a eşit
        emit RoomSettled(roomId, ranking[0], ranking[1], pot);
    }

    /// @notice Alacağını çek. Sıra önemli: önce sıfırla, sonra gönder (checks-effects-interactions)
    function withdraw() external {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        claimable[msg.sender] = 0; // geri çağrılsa (reentrancy) bile ikinci kez çekecek bir şey kalmaz
        emit Withdrawn(msg.sender, amount); // olay da gönderimden ÖNCE: geri çağrı olay sırasını karıştıramasın
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice İade: oda 10 dakikada dolmadıysa (ya da başlayıp 1 günde sonuçlanmadıysa) ücretini geri al
    function refund(uint256 roomId) external {
        Room storage r = rooms[roomId];
        if (!joined[roomId][msg.sender]) revert NotInRoom(roomId, msg.sender);
        if (r.settled) revert AlreadySettled(roomId);
        bool notFilled = r.startedAt == 0 && block.timestamp >= r.createdAt + JOIN_WINDOW;
        bool notSettled = r.startedAt != 0 && block.timestamp >= r.startedAt + SETTLE_WINDOW;
        if (!notFilled && !notSettled) revert RefundNotAvailable(roomId);

        // İade alan odadan düşer: ikinci iade yok, bu oda artık settle da edilemez (NotInRoom)
        joined[roomId][msg.sender] = false;
        uint256 amount = r.entryFee;
        emit Refunded(roomId, msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // =========================================================================
    // Okuma
    // =========================================================================

    /// @notice Oda bilgisi (oyun sunucusu ödemeyi buradan doğrular)
    function getRoom(uint256 roomId)
        external
        view
        returns (uint256 entryFee, uint8 maxPlayers, uint64 createdAt, uint64 startedAt, bool settled, address[] memory players)
    {
        Room storage r = rooms[roomId];
        return (r.entryFee, r.maxPlayers, r.createdAt, r.startedAt, r.settled, r.players);
    }
}
