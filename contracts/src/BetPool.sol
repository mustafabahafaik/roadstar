// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface IRacePool {
    function getRoom(uint256 roomId)
        external
        view
        returns (uint256 entryFee, uint8 maxPlayers, uint64 createdAt, uint64 startedAt, bool settled, address[] memory players);
}

/// @title BetPool — izleyici bahsi: "kim kazanır?" sorusuna herkes aynı tutarı (0.01 MON) yatırır
/// @notice Parimutuel: oran = toplam havuz / kazanana yatırılan. Kasa payı yok, havuzun tamamı kazananlara bölünür.
///         Kimse kazananı bilemediyse (ya da kazanan yoksa) herkes parasını geri alır.
///         Kazananı zincir göremez: oyun sunucusu imzalar (RacePool ile aynı imzacı). Oda numarası RacePool'unki.
///         Ödeme: payout kazananlara partiler halinde DOĞRUDAN gönderir (izleyici bir şey yapmaz). Gönderilemeyen
///         olursa döngü durmaz, alacak olarak yazılır ve claim() ile çekilir.
contract BetPool {
    uint256 public constant BET_AMOUNT = 0.01 ether;
    uint256 public constant EXPIRE_AFTER = 1 days; // sonuçlanmayan bahis bu süreden sonra iade olur (sunucu çökerse)
    uint256 public constant TRANSFER_GAS = 10_000; // alıcıya verilen gaz: kötü niyetli bir kontrat döngüyü tüketemesin

    // Gaz notu: Monad ücreti limitten keser ve izleyici faucet'ten sadece 0.025 MON alır (0.01 bahis + gaz).
    // Bu yüzden placeBet'in dokunduğu her şey 1. yuvada: süre, bahis sayısı ve 5 yarışçının sayıları (8 + 4 + 5×4 = 32 bayt).
    // (Sabit dizi uint32[5] yazsaydık Solidity onu yeni bir yuvadan başlatırdı: 5 ayrı alan)
    struct Book {
        // 1. yuva: placeBet tek okuma + tek yazmayla günceller
        uint64 deadline; // bahisler bu ana kadar (dahil) açık; 0 = hiç açılmadı
        uint32 betCount;
        uint32 count0; // yarışçı başına bahis sayısı
        uint32 count1;
        uint32 count2;
        uint32 count3;
        uint32 count4;
        // 2. yuva: sonuç (settle yazar)
        uint32 winnerCount; // kazanana yatıran kişi sayısı
        uint8 racerCount;
        uint8 winnerIndex; // kazananın racers içindeki sırası
        bool settled;
        bool refundAll; // kimse bilemedi ya da kazanan yok → herkese iade
        // 3.–7. yuvalar: openBets anında RacePool'dan okunan yarışçılar
        address[5] racers;
    }

    struct Bet {
        address bettor; // 20 bayt + 1 + 1: tek yuva
        uint8 racerIndex;
        bool paid;
    }

    IRacePool public immutable racePool;
    /// @notice Sunucu: bahisleri açar (operator) ve kazananı imzalar
    address public immutable resultSigner;

    mapping(uint256 roomId => Book) internal books;
    /// @dev Bahisler sırayla (0, 1, 2…): payout partileri bu sırayla ilerler. Dizi değil: uzunluk zaten betCount'ta
    mapping(uint256 roomId => mapping(uint256 index => Bet)) internal bets;
    /// @dev Yarışçının sırası + 1 (0 = yarışçı değil): placeBet yarışçıyı döngüyle değil tek okumayla bulur
    mapping(uint256 roomId => mapping(address racer => uint8)) internal racerSlot;
    /// @notice Kimin kime yatırdığı: racerIndex + 1 (0 = bahis yok). Kişi başı tek bahis
    mapping(uint256 roomId => mapping(address bettor => uint8)) public pickOf;
    /// @notice Gönderilemeyen ödemeler (alıcı kontrat parayı reddetti): claim() ile çekilir
    mapping(address account => uint256) public claimable;

    event BetsOpened(uint256 indexed roomId, uint64 deadline, address[] racers);
    event BetPlaced(uint256 indexed roomId, address indexed bettor, address indexed racer);
    event BetsSettled(uint256 indexed roomId, address winner, bool refundAll, uint256 pot);
    event Paid(uint256 indexed roomId, address indexed bettor, uint256 amount);
    event PayoutDeferred(uint256 indexed roomId, address indexed bettor, uint256 amount);
    event Claimed(address indexed account, uint256 amount);
    event Airdropped(address indexed sender, uint256 recipients, uint256 each);

    error NotOperator();
    error BadDeadline();
    error RoomNotStarted(uint256 roomId);
    error AlreadyOpen(uint256 roomId);
    error BetsNotOpen(uint256 roomId);
    error BetsClosed(uint256 roomId);
    error BetsStillOpen(uint256 roomId);
    error WrongAmount(uint256 sent, uint256 expected);
    error AlreadyBet(uint256 roomId, address bettor);
    error NotARacer(address racer);
    error AlreadySettled(uint256 roomId);
    error NotSettled(uint256 roomId);
    error NotExpired(uint256 roomId);
    error InvalidSignature();
    error NothingToClaim();
    error TransferFailed();
    error ZeroAddress();
    error NoRecipients();

    constructor(IRacePool racePool_, address resultSigner_) {
        if (address(racePool_) == address(0) || resultSigner_ == address(0)) revert ZeroAddress();
        racePool = racePool_;
        resultSigner = resultSigner_;
    }

    // =========================================================================
    // Bahis
    // =========================================================================

    /// @notice Bahsi aç (sadece sunucu). Yarışçılar RacePool odasından okunur: oda dolmuş (başlamış) olmalı
    function openBets(uint256 roomId, uint64 deadline) external {
        if (msg.sender != resultSigner) revert NotOperator();
        Book storage b = books[roomId];
        if (b.deadline != 0) revert AlreadyOpen(roomId);
        if (deadline <= block.timestamp) revert BadDeadline();
        (,,, uint64 startedAt,, address[] memory players) = racePool.getRoom(roomId);
        if (startedAt == 0) revert RoomNotStarted(roomId); // oda dolmadan yarışçılar belli değil

        b.deadline = deadline;
        b.racerCount = uint8(players.length); // RacePool en fazla 5 kişi
        for (uint256 i = 0; i < players.length; i++) {
            b.racers[i] = players[i];
            racerSlot[roomId][players[i]] = uint8(i + 1);
        }
        emit BetsOpened(roomId, deadline, players);
    }

    /// @notice Bir yarışçıya tam BET_AMOUNT yatır. Kişi başı tek bahis, son ana kadar
    function placeBet(uint256 roomId, address racer) external payable {
        Book storage b = books[roomId];
        if (b.deadline == 0) revert BetsNotOpen(roomId);
        if (block.timestamp > b.deadline) revert BetsClosed(roomId);
        if (msg.value != BET_AMOUNT) revert WrongAmount(msg.value, BET_AMOUNT);
        if (pickOf[roomId][msg.sender] != 0) revert AlreadyBet(roomId, msg.sender);
        uint8 index = _racerIndex(roomId, racer); // odada değilse revert

        pickOf[roomId][msg.sender] = index + 1;
        uint32 n = b.betCount;
        bets[roomId][n] = Bet(msg.sender, index, false);
        b.betCount = n + 1;
        _addBet(b, index);
        emit BetPlaced(roomId, msg.sender, racer);
    }

    function _racerIndex(uint256 roomId, address racer) internal view returns (uint8) {
        uint8 slot = racerSlot[roomId][racer];
        if (slot == 0) revert NotARacer(racer);
        return slot - 1;
    }

    function _addBet(Book storage b, uint8 index) internal {
        if (index == 0) b.count0++;
        else if (index == 1) b.count1++;
        else if (index == 2) b.count2++;
        else if (index == 3) b.count3++;
        else b.count4++;
    }

    function _countOf(Book storage b, uint256 index) internal view returns (uint32) {
        if (index == 0) return b.count0;
        if (index == 1) return b.count1;
        if (index == 2) return b.count2;
        if (index == 3) return b.count3;
        return b.count4;
    }

    // =========================================================================
    // Sonuç ve ödeme
    // =========================================================================

    /// @notice Sunucunun imzaladığı özet. "BET" + zincir + kontrat adresi: imza RacePool'da ya da başka yerde geçmez
    function resultHash(uint256 roomId, address winner) public view returns (bytes32) {
        return keccak256(abi.encode("BET", block.chainid, address(this), roomId, winner));
    }

    /// @notice Kazananı yaz (herkes çağırabilir: imza yetki verir). winner = address(0): kimse bitiremedi → iade
    function settleBets(uint256 roomId, address winner, bytes calldata signature) external {
        Book storage b = books[roomId];
        if (b.deadline == 0) revert BetsNotOpen(roomId);
        if (block.timestamp <= b.deadline) revert BetsStillOpen(roomId); // bahis sürerken sonuç yok
        if (b.settled) revert AlreadySettled(roomId);
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(resultHash(roomId, winner));
        if (ECDSA.recover(digest, signature) != resultSigner) revert InvalidSignature();

        b.settled = true;
        if (winner == address(0)) {
            b.refundAll = true;
        } else {
            uint8 index = _racerIndex(roomId, winner);
            b.winnerIndex = index;
            b.winnerCount = _countOf(b, index);
            if (b.winnerCount == 0) b.refundAll = true; // kimse bilemedi: havuz sahiplerine döner
        }
        emit BetsSettled(roomId, winner, b.refundAll, b.betCount * BET_AMOUNT);
    }

    /// @notice Sunucu sonucu hiç yazmadıysa (çöktü): 1 gün sonra herkes çağırabilir → herkese iade
    function expire(uint256 roomId) external {
        Book storage b = books[roomId];
        if (b.deadline == 0) revert BetsNotOpen(roomId);
        if (b.settled) revert AlreadySettled(roomId);
        if (block.timestamp <= b.deadline + EXPIRE_AFTER) revert NotExpired(roomId);
        b.settled = true;
        b.refundAll = true;
        emit BetsSettled(roomId, address(0), true, b.betCount * BET_AMOUNT);
    }

    /// @notice Bahis sırasıyla [start, start + count) arasındakilere öde (partiler: tek işlemde 100 kişi gaza sığmaz).
    ///         Herkes çağırabilir; ödenen işaretlenir, iki kez ödenmez. Gönderilemeyen alacağa yazılır, döngü sürer
    function payout(uint256 roomId, uint256 start, uint256 count) external {
        Book storage b = books[roomId];
        if (!b.settled) revert NotSettled(roomId);
        uint256 total = b.betCount;
        uint256 pot = total * BET_AMOUNT;
        uint256 end = start + count < total ? start + count : total;
        for (uint256 i = start; i < end; i++) {
            Bet storage bet = bets[roomId][i];
            if (bet.paid) continue;
            uint256 amount = b.refundAll ? BET_AMOUNT : bet.racerIndex == b.winnerIndex ? pot / b.winnerCount : 0;
            if (amount == 0) continue; // kaybeden: ödenecek bir şey yok

            bet.paid = true; // önce işaretle, sonra gönder (checks-effects-interactions)
            if (_send(bet.bettor, amount)) {
                emit Paid(roomId, bet.bettor, amount);
            } else {
                claimable[bet.bettor] += amount;
                emit PayoutDeferred(roomId, bet.bettor, amount);
            }
        }
    }

    /// @notice payout'ta gönderilemeyen alacağını çek
    function claim() external {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Claimed(msg.sender, amount);
    }

    /// @notice Sunucunun faucet'i için toplu gönderim: msg.value alıcılara eşit bölünür.
    ///         Neden: Monad'da 10 MON altındaki cüzdan art arda MON gönderemez (rezerv kuralı); 100 izleyiciye tek tek
    ///         gönderim beklemekle biterdi. Gönderilemeyen pay (ve bölme artığı) gönderene iade edilir
    function airdrop(address[] calldata to) external payable {
        if (to.length == 0) revert NoRecipients();
        uint256 each = msg.value / to.length;
        uint256 back = msg.value - each * to.length;
        for (uint256 i = 0; i < to.length; i++) {
            if (!_send(to[i], each)) back += each;
        }
        if (back > 0) {
            (bool ok,) = msg.sender.call{value: back}("");
            if (!ok) revert TransferFailed();
        }
        emit Airdropped(msg.sender, to.length, each);
    }

    /// @dev Sınırlı gazla MON gönder, alıcının döndürdüğü veriyi HİÇ kopyalama. Neden assembly: Solidity'nin
    ///      .call'ı cevabı belleğe kopyalar; kötü niyetli alıcı dev bir cevapla döngünün gazını bitirebilirdi
    function _send(address to, uint256 amount) private returns (bool ok) {
        uint256 gasLimit = TRANSFER_GAS;
        assembly {
            ok := call(gasLimit, to, amount, 0, 0, 0, 0)
        }
    }

    // =========================================================================
    // Okuma
    // =========================================================================

    /// @notice Sunucunun tek çağrıda istediği her şey: süre, durum, kazanan, yarışçılar ve her birine kaç bahis
    function getBook(uint256 roomId)
        external
        view
        returns (uint64 deadline, bool settled, bool refundAll, address winner, uint256 betCount, address[] memory racers, uint32[] memory counts)
    {
        Book storage b = books[roomId];
        racers = new address[](b.racerCount);
        counts = new uint32[](b.racerCount);
        for (uint256 i = 0; i < b.racerCount; i++) {
            racers[i] = b.racers[i];
            counts[i] = _countOf(b, i);
        }
        winner = b.settled && !b.refundAll ? b.racers[b.winnerIndex] : address(0);
        return (b.deadline, b.settled, b.refundAll, winner, b.betCount, racers, counts);
    }
}
