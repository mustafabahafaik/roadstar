// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

/// @title RaceItems — yolda toplanan tokenlar (ERC1155, transfer edilemez, odaya bağlı)
/// @notice Token türü oyundakiyle aynı formülle hesaplanır: keccak256(abi.encode(roomId, index))
contract RaceItems is ERC1155 {
    // --- Token türleri (oyundaki src/items.js TOKEN_TYPES ile aynı numaralar) ---
    uint8 public constant THRUST = 0; // Thrust Cell
    uint8 public constant SHIELD = 1; // Kalkan
    uint8 public constant MAGNET = 2; // Mıknatıs
    uint8 public constant RUSH = 3; // Block Rush
    uint8 public constant GOLD = 4; // Altın (nadir, kullanılamaz; ileride NFT)

    /// @notice Bir odada kaç token var (oyundaki TOKEN_COUNT)
    uint256 public constant ITEMS_PER_ROOM = 40;

    // --- Depolama ---
    /// @notice Oyuncu bu odaya kayıtlı mı? (şimdilik basit; sonra yarış kontratı yönetecek)
    mapping(uint256 roomId => mapping(address player => bool)) public isPlayer;

    /// @notice Oyuncu bu odada bu index'teki tokenı topladı mı? (aynı tokenı iki kez toplamayı engeller)
    mapping(uint256 roomId => mapping(address player => mapping(uint256 index => bool))) public collected;

    // --- Olaylar (zincire yazılan loglar; oyun bunları dinleyebilir) ---
    event PlayerJoined(uint256 indexed roomId, address indexed player);
    event ItemCollected(uint256 indexed roomId, address indexed player, uint256 index, uint8 itemType);
    event SkillUsed(uint256 indexed roomId, address indexed player, uint8 itemType);

    // --- Hatalar ---
    error NotInRoom(uint256 roomId, address player);
    error IndexOutOfRange(uint256 index);
    error AlreadyCollected(uint256 roomId, uint256 index);
    error InvalidItemType(uint8 itemType);
    error GoldNotUsable();
    error NoItem(uint256 roomId, uint8 itemType);
    error RoomIdTooLarge(uint256 roomId);
    error NonTransferable();

    /// @dev ERC1155 her token için bir metadata adresi ister; şimdilik boş
    constructor() ERC1155("") {}

    // =========================================================================
    // Hesaplamalar (pure: zincirden veri okumaz, dışarıdan çağırmak bedava)
    // =========================================================================

    /// @notice index'teki tokenın türü. Oyundaki src/random.js → itemTypeFromHash ile AYNI eşikler
    /// @dev hash % 10000 → 0..9999. 0-499 Altın (%5); kalan 9500'ün %40 Thrust, %20'şer diğerleri
    function itemAt(uint256 roomId, uint256 index) public pure returns (uint8) {
        uint256 roll = uint256(keccak256(abi.encode(roomId, index))) % 10000;
        if (roll < 500) return GOLD;
        roll -= 500; // 0..9499
        if (roll < 3800) return THRUST; // 9500 × 0.40
        if (roll < 5700) return SHIELD; // + 9500 × 0.20
        if (roll < 7600) return MAGNET; // + 9500 × 0.20
        return RUSH;
    }

    /// @notice Odaya bağlı token id: (roomId << 8) | tür → aynı tür farklı odalarda farklı id
    /// @dev << 8 = 256 ile çarpma; sağdaki 8 bit türe ayrılır. Örnek: oda 1 kalkan = 1*256 + 1 = 257
    function tokenId(uint256 roomId, uint8 itemType) public pure returns (uint256) {
        if (roomId > type(uint248).max) revert RoomIdTooLarge(roomId); // kaydırınca bit kaybolmasın
        if (itemType > GOLD) revert InvalidItemType(itemType);
        return (roomId << 8) | itemType;
    }

    /// @notice id → oda (sağa 8 bit kaydır, tür bitleri düşer)
    function roomOf(uint256 id) public pure returns (uint256) {
        return id >> 8;
    }

    /// @notice id → tür (son 8 biti al: 0xff = 11111111)
    function typeOf(uint256 id) public pure returns (uint8) {
        return uint8(id & 0xff);
    }

    // =========================================================================
    // Oyuncu işlemleri (sıra: kontroller → durum değişikliği → mint/burn ve event)
    // =========================================================================

    /// @notice Odaya kayıt ol. Şimdilik herkes katılabilir; sonra yarış kontratı yönetecek
    function joinRoom(uint256 roomId) external {
        isPlayer[roomId][msg.sender] = true;
        emit PlayerJoined(roomId, msg.sender);
    }

    /// @notice Yolda bir tokenı topla: türü itemAt'ten hesaplanır ve oyuncuya mint edilir
    function collect(uint256 roomId, uint256 index) external {
        // 1) Kontroller
        if (!isPlayer[roomId][msg.sender]) revert NotInRoom(roomId, msg.sender);
        if (index >= ITEMS_PER_ROOM) revert IndexOutOfRange(index);
        if (collected[roomId][msg.sender][index]) revert AlreadyCollected(roomId, index);

        // 2) Durum: önce "toplandı" işaretle (mint sırasında geri çağrılsa bile ikinci kez alamaz)
        collected[roomId][msg.sender][index] = true;

        // 3) Mint + event. Türü oyuncu seçemez: her zaman formülden gelir
        uint8 itemType = itemAt(roomId, index);
        _mint(msg.sender, tokenId(roomId, itemType), 1, "");
        emit ItemCollected(roomId, msg.sender, index, itemType);
    }

    /// @notice Envanterdeki bir skill'i kullan: o odadaki tokenından 1 tane yakılır (burn)
    function useSkill(uint256 roomId, uint8 itemType) external {
        if (!isPlayer[roomId][msg.sender]) revert NotInRoom(roomId, msg.sender);
        if (itemType == GOLD) revert GoldNotUsable(); // altın saklanır, harcanmaz
        uint256 id = tokenId(roomId, itemType); // geçersiz türde (>4) burada revert eder
        if (balanceOf(msg.sender, id) == 0) revert NoItem(roomId, itemType);

        _burn(msg.sender, id, 1);
        emit SkillUsed(roomId, msg.sender, itemType);
    }

    // =========================================================================
    // Transfer engeli (soulbound): mint ve burn serbest, oyuncudan oyuncuya transfer yok
    // =========================================================================

    /// @dev OpenZeppelin v5'te mint, burn ve transfer hepsi _update'ten geçer.
    ///      Mint: from = 0 adresi. Burn: to = 0 adresi. İkisi de 0 değilse transferdir → reddet
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        override
    {
        if (from != address(0) && to != address(0)) revert NonTransferable();
        super._update(from, to, ids, values); // asıl bakiye işlemini OpenZeppelin yapsın
    }
}
