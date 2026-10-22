// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {GarageParts} from "../src/GarageParts.sol";

contract GaragePartsTest is Test {
    GarageParts garage;
    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    // Küçük test kataloğu (gerçeği shared/parts.json): her slotun ilk parçası ücretsiz
    uint256 constant WHITE = 1; // boya, varsayılan
    uint256 constant PURPLE = 2; // boya, 0.02 MON
    uint256 constant GRAPHITE = 11; // jant, varsayılan
    uint256 constant CHROME = 12; // jant, 0.01 MON

    function setUp() public {
        garage = new GarageParts(owner);
        vm.startPrank(owner);
        garage.definePart(WHITE, 0, 0);
        garage.definePart(PURPLE, 0, 0.02 ether);
        garage.definePart(GRAPHITE, 1, 0);
        garage.definePart(CHROME, 1, 0.01 ether);
        for (uint8 slot = 2; slot < 5; slot++) garage.definePart(slot * 10 + 1, slot, 0); // 21, 31, 41
        vm.stopPrank();
        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
    }

    // =====================================================================
    // Benim testlerim
    // =====================================================================

    // Test 1: satın al + tak → loadout değişir, para kontratta, token cüzdanda
    function test_buyAndEquip() public {
        uint256[5] memory before = garage.loadoutOf(alice);
        assertEq(before[0], WHITE, "hic takmadiysa varsayilan boya");
        assertEq(before[1], GRAPHITE);

        vm.startPrank(alice);
        garage.buy{value: 0.02 ether}(PURPLE);
        assertEq(garage.balanceOf(alice, PURPLE), 1, "1 adet mint edildi");
        assertEq(garage.loadoutOf(alice)[0], WHITE, "satin almak takmak degil");

        garage.equip(PURPLE);
        vm.stopPrank();
        assertEq(garage.loadoutOf(alice)[0], PURPLE, "takinca loadout degisir");
        assertEq(garage.loadoutOf(alice)[1], GRAPHITE, "diger slotlar ayni kalir");
        assertEq(address(garage).balance, 0.02 ether, "para kontratta");

        // Varsayılana geri dönmek ücretsiz (herkes sahip)
        vm.prank(alice);
        garage.equip(WHITE);
        assertEq(garage.loadoutOf(alice)[0], WHITE);
    }

    // Test 2: sahip olmadığın parçayı takamazsın; aktardığın parça loadout'tan düşer
    function test_equip_notOwned_reverts() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(GarageParts.NotOwned.selector, CHROME));
        garage.equip(CHROME);

        // alice alıp takar, sonra bob'a aktarır → alice'in loadout'u varsayılana döner, bob takabilir
        vm.startPrank(alice);
        garage.buy{value: 0.01 ether}(CHROME);
        garage.equip(CHROME);
        garage.safeTransferFrom(alice, bob, CHROME, 1, "");
        vm.stopPrank();
        assertEq(garage.loadoutOf(alice)[1], GRAPHITE, "aktarilan parca loadout'tan duser");
        vm.prank(bob);
        garage.equip(CHROME);
        assertEq(garage.loadoutOf(bob)[1], CHROME);
    }

    // Ek: katalog kuralları (sadece owner, ilk parça ücretsiz, tekrar tanım yok) ve tekrar satın alma yok
    function test_catalogRules() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        garage.definePart(99, 0, 1 ether);

        GarageParts fresh = new GarageParts(owner);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(GarageParts.FirstPartMustBeFree.selector, uint8(3)));
        fresh.definePart(31, 3, 0.01 ether);
        vm.expectRevert(GarageParts.InvalidPartId.selector);
        fresh.definePart(0, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(GarageParts.InvalidSlot.selector, uint8(5)));
        fresh.definePart(7, 5, 0);
        vm.expectRevert(abi.encodeWithSelector(GarageParts.PartAlreadyDefined.selector, WHITE));
        garage.definePart(WHITE, 0, 0);
        vm.stopPrank();

        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(GarageParts.AlreadyOwned.selector, WHITE));
        garage.buy(WHITE); // varsayılan zaten herkesin
        garage.buy{value: 0.02 ether}(PURPLE);
        vm.expectRevert(abi.encodeWithSelector(GarageParts.AlreadyOwned.selector, PURPLE));
        garage.buy{value: 0.02 ether}(PURPLE);
        vm.stopPrank();
    }

    // Ek: satış geliri sadece owner'a, tamamı çekilir
    function test_withdraw_onlyOwner() public {
        vm.prank(alice);
        garage.buy{value: 0.02 ether}(PURPLE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        garage.withdraw(alice);

        address treasury = makeAddr("treasury");
        vm.prank(owner);
        garage.withdraw(treasury);
        assertEq(treasury.balance, 0.02 ether);
        assertEq(address(garage).balance, 0);
    }

    // =====================================================================
    // Senin testin (vm.skip: yazana kadar "atlandı" görünür). Yazınca vm.skip satırını sil.
    // =====================================================================

    // Test 3: yanlış fiyatla satın alınamaz
    // İpucu: PURPLE 0.02 ether. Eksik (0.01) ve fazla (0.03) gönderince WrongPrice(gönderilen, beklenen)
    //        beklenmeli; hiç para göndermeden de dene. Sonunda alice'in PURPLE bakiyesi hâlâ 0 olmalı
    function test_buy_wrongPrice_reverts() public {
        // Eksik
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GarageParts.WrongPrice.selector, 0.01 ether, 0.02 ether));
        garage.buy{value: 0.01 ether}(PURPLE);

        // Fazla
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GarageParts.WrongPrice.selector, 0.03 ether, 0.02 ether));
        garage.buy{value: 0.03 ether}(PURPLE);

        // Hiç para göndermeden
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GarageParts.WrongPrice.selector, 0, 0.02 ether));
        garage.buy(PURPLE);

        // Hiçbiri mint etmedi, para da kontrata girmedi
        assertEq(garage.balanceOf(alice, PURPLE), 0);
        assertEq(address(garage).balance, 0);
        assertEq(alice.balance, 1 ether);
    }
}
