// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title GarageParts — garajdaki araba parçaları (ERC1155). SADECE GÖRSEL: hıza, boyuta, çarpışmaya etkisi yok
/// @notice Her parçanın bir slotu var (boya, jant, arka kanat, alt neon, itici alevi). Oyuncu parçayı satın alır
///         (buy), sonra takar (equip). loadoutOf her slotta takılı parçayı verir; oyun ve rakipler arabayı buna göre boyar.
///         Parçalar normal ERC1155: başkasına aktarılabilir (takas). Aktarılan parça loadout'tan kendiliğinden düşer.
contract GarageParts is ERC1155, Ownable {
    uint8 public constant SLOT_COUNT = 5; // 0 boya, 1 jant, 2 arka kanat, 3 alt neon, 4 itici alevi

    struct Part {
        bool exists;
        uint8 slot;
        uint128 price; // wei
    }

    mapping(uint256 id => Part) public parts;
    /// @notice Her slotun varsayılan parçası: o slota ilk tanımlanan (ücretsiz, herkes sahip sayılır)
    mapping(uint8 slot => uint256 id) public defaultPart;
    mapping(address player => mapping(uint8 slot => uint256 id)) internal equipped; // 0 = takılmadı → varsayılan

    // --- Olaylar ---
    event PartDefined(uint256 indexed id, uint8 indexed slot, uint256 price);
    event PartBought(address indexed buyer, uint256 indexed id, uint256 price);
    event PartEquipped(address indexed player, uint8 indexed slot, uint256 indexed id);
    event Withdrawn(address indexed to, uint256 amount);

    // --- Hatalar ---
    error InvalidPartId();
    error InvalidSlot(uint8 slot);
    error PartAlreadyDefined(uint256 id);
    error FirstPartMustBeFree(uint8 slot);
    error PriceTooHigh(uint256 price);
    error UnknownPart(uint256 id);
    error WrongPrice(uint256 sent, uint256 expected);
    error AlreadyOwned(uint256 id);
    error NotOwned(uint256 id);
    error TransferFailed();
    error ZeroAddress();

    /// @dev ERC1155 her token için bir metadata adresi ister; şimdilik boş (isim ve renk shared/parts.json'da)
    constructor(address initialOwner) ERC1155("") Ownable(initialOwner) {}

    // =========================================================================
    // Katalog (sadece owner)
    // =========================================================================

    /// @notice Yeni parça tanımla. Bir slotun ilk parçası ücretsiz olmak zorunda ve o slotun varsayılanı olur.
    ///         Tanımlanan parça değiştirilemez (fiyat sonradan oynatılamaz: oyuncu ne gördüyse onu öder)
    function definePart(uint256 id, uint8 slot, uint256 price) external onlyOwner {
        if (id == 0) revert InvalidPartId(); // 0 = "takılmadı" anlamına geliyor
        if (slot >= SLOT_COUNT) revert InvalidSlot(slot);
        if (parts[id].exists) revert PartAlreadyDefined(id);
        if (price > type(uint128).max) revert PriceTooHigh(price);
        if (defaultPart[slot] == 0) {
            if (price != 0) revert FirstPartMustBeFree(slot);
            defaultPart[slot] = id;
        }
        parts[id] = Part({exists: true, slot: slot, price: uint128(price)});
        emit PartDefined(id, slot, price);
    }

    // =========================================================================
    // Oyuncu: satın al, tak
    // =========================================================================

    /// @notice Varsayılan parçaya herkes sahiptir; diğerlerine sahip olmak için en az 1 token gerekir
    function owns(address player, uint256 id) public view returns (bool) {
        Part storage p = parts[id];
        if (!p.exists) return false;
        return defaultPart[p.slot] == id || balanceOf(player, id) > 0;
    }

    /// @notice Parçayı tam fiyatıyla satın al (1 adet mint edilir). Sahip olduğun parça tekrar alınamaz
    function buy(uint256 id) external payable {
        Part storage p = parts[id];
        if (!p.exists) revert UnknownPart(id);
        if (msg.value != p.price) revert WrongPrice(msg.value, p.price);
        if (owns(msg.sender, id)) revert AlreadyOwned(id); // varsayılanlar da dahil: zaten herkesin
        emit PartBought(msg.sender, id, msg.value);
        _mint(msg.sender, id, 1, "");
    }

    /// @notice Parçayı kendi slotuna tak. Sahip olmadığın parçayı takamazsın
    function equip(uint256 id) external {
        Part storage p = parts[id];
        if (!p.exists) revert UnknownPart(id);
        if (!owns(msg.sender, id)) revert NotOwned(id);
        equipped[msg.sender][p.slot] = id;
        emit PartEquipped(msg.sender, p.slot, id);
    }

    /// @notice Her slotta takılı parça. Hiç takılmadıysa ya da takılı parça başkasına aktarıldıysa: varsayılan
    function loadoutOf(address player) external view returns (uint256[SLOT_COUNT] memory ids) {
        for (uint8 slot = 0; slot < SLOT_COUNT; slot++) {
            uint256 id = equipped[player][slot];
            ids[slot] = id != 0 && owns(player, id) ? id : defaultPart[slot];
        }
    }

    // =========================================================================
    // Satış geliri (owner, pull)
    // =========================================================================

    function withdraw(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress(); // 0x0'a gönderilen para yanar
        uint256 amount = address(this).balance;
        emit Withdrawn(to, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
