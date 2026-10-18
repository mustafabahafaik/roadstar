// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

/// @title RaceItems — yolda toplanan tokenlar (ERC1155, transfer edilemez, yarışa bağlı)
/// @notice Sadece token işini yapar. Kurallar (ne zaman, kim, hangi token) Race kontratındadır;
///         mint ve burn'ü yalnızca Race (minter) yapabilir
contract RaceItems is ERC1155 {
    // --- Token türleri (oyundaki src/items.js TOKEN_TYPES ile aynı numaralar) ---
    uint8 public constant THRUST = 0; // Thrust Cell
    uint8 public constant SHIELD = 1; // Kalkan
    uint8 public constant MAGNET = 2; // Mıknatıs
    uint8 public constant RUSH = 3; // Block Rush
    uint8 public constant GOLD = 4; // Altın (nadir, kullanılamaz; ileride NFT)

    /// @notice Mint/burn yetkisi olan tek adres: Race kontratı (constructor'da bir kez yazılır)
    address public immutable minter;

    error NotMinter(address caller);
    error InvalidItemType(uint8 itemType);
    error RoomIdTooLarge(uint256 roomId);
    error NonTransferable();

    /// @dev ERC1155 her token için bir metadata adresi ister; şimdilik boş
    constructor(address minter_) ERC1155("") {
        minter = minter_;
    }

    /// @dev Bu kontrolle başlayan fonksiyonları sadece minter (Race) çağırabilir
    modifier onlyMinter() {
        if (msg.sender != minter) revert NotMinter(msg.sender);
        _;
    }

    // =========================================================================
    // Token id: yarışa bağlı
    // =========================================================================

    /// @notice (roomId << 8) | tür → aynı tür farklı yarışlarda farklı id.
    /// @dev << 8 = 256 ile çarpma; sağdaki 8 bit türe ayrılır. Örnek: yarış 1 kalkan = 1*256 + 1 = 257
    function tokenId(uint256 roomId, uint8 itemType) public pure returns (uint256) {
        if (roomId > type(uint248).max) revert RoomIdTooLarge(roomId); // kaydırınca bit kaybolmasın
        if (itemType > GOLD) revert InvalidItemType(itemType);
        return (roomId << 8) | itemType;
    }

    /// @notice id → yarış (sağa 8 bit kaydır, tür bitleri düşer)
    function roomOf(uint256 id) public pure returns (uint256) {
        return id >> 8;
    }

    /// @notice id → tür (son 8 biti al: 0xff = 11111111)
    function typeOf(uint256 id) public pure returns (uint8) {
        return uint8(id & 0xff);
    }

    // =========================================================================
    // Mint / burn (sadece Race)
    // =========================================================================

    function mint(address to, uint256 roomId, uint8 itemType) external onlyMinter {
        _mint(to, tokenId(roomId, itemType), 1, "");
    }

    function burn(address from, uint256 roomId, uint8 itemType) external onlyMinter {
        _burn(from, tokenId(roomId, itemType), 1); // bakiye yoksa OpenZeppelin revert eder
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
