// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RaceItems} from "../src/RaceItems.sol";

contract RaceItemsTest is Test {
    RaceItems items;

    uint256 constant ROOM = 1;
    address alice = makeAddr("alice"); // makeAddr: isimden sahte bir test adresi üretir
    address bob = makeAddr("bob");

    // Her testten önce çalışır: temiz bir kontrat kur, alice ve bob odaya katılsın
    function setUp() public {
        items = new RaceItems();
        vm.prank(alice); // bir sonraki çağrıyı alice yapmış gibi
        items.joinRoom(ROOM);
        vm.prank(bob);
        items.joinRoom(ROOM);
    }

    // ---------------------------------------------------------------------
    // Test 1: aynı index iki kez toplanamaz
    // ---------------------------------------------------------------------
    function test_collect_sameIndexTwice_reverts() public {
        vm.startPrank(alice); // stopPrank'e kadar tüm çağrılar alice'ten

        items.collect(ROOM, 0);
        uint256 id = items.tokenId(ROOM, items.itemAt(ROOM, 0));
        assertEq(items.balanceOf(alice, id), 1, "ilk toplama 1 token vermeli");

        // İkinci deneme AlreadyCollected(ROOM, 0) hatasıyla geri dönmeli
        vm.expectRevert(abi.encodeWithSelector(RaceItems.AlreadyCollected.selector, ROOM, uint256(0)));
        items.collect(ROOM, 0);

        vm.stopPrank();

        // Başka bir oyuncu aynı index'i toplayabilir (kontrol oyuncu başına)
        vm.prank(bob);
        items.collect(ROOM, 0);
        assertEq(items.balanceOf(bob, id), 1, "bob da kendi kopyasini toplayabilmeli");
    }

    // ---------------------------------------------------------------------
    // Test 2: itemAt deterministik — aynı girdi her zaman aynı sonuç (fuzz testi)
    // Foundry bu fonksiyonu yüzlerce rastgele roomId / index ile çağırır
    // ---------------------------------------------------------------------
    function testFuzz_itemAt_isDeterministic(uint256 roomId, uint256 index) public view {
        uint8 first = items.itemAt(roomId, index);
        uint8 second = items.itemAt(roomId, index);
        assertEq(first, second, "ayni girdi farkli sonuc verdi");
        assertLe(first, items.GOLD(), "tur 0-4 araliginda olmali");
    }

    // Ek: kontrat, oyunun (src/random.js) hesapladığı türlerle aynı sonucu veriyor mu?
    // Beklenen değerler: node ile itemTypeFromHash(itemHash(1, i)), i = 0..9
    function test_itemAt_matchesGame() public view {
        uint8[10] memory fromGame = [2, 0, 3, 0, 4, 0, 0, 0, 0, 3];
        for (uint256 i = 0; i < fromGame.length; i++) {
            assertEq(items.itemAt(ROOM, i), fromGame[i], "oyun ile kontrat farkli tur hesapliyor");
        }
    }

    // ---------------------------------------------------------------------
    // SENİN TESTLERİN (aşağıdaki üçünü sen yaz; ipuçları yorumlarda)
    // ---------------------------------------------------------------------

    // Test 3: transfer revert eder
    // İpucu: alice bir token toplasın (collect). Sonra alice olarak
    // items.safeTransferFrom(alice, bob, id, 1, "") çağır ve NonTransferable hatası bekle.
    // Hata parametresizse: vm.expectRevert(RaceItems.NonTransferable.selector)
    // function test_transfer_reverts() public { }

    // Test 4: useSkill token'ı yakar, olmayan token için revert eder
    // İpucu: türü kalkan/mıknatıs/rush olan bir index bul (fromGame listesine bak: index 0 = Mıknatıs).
    // Topla → useSkill → bakiye 0 olmalı. Tekrar useSkill → NoItem(ROOM, tür) hatası bekle.
    // function test_useSkill_burns_and_revertsWhenEmpty() public { }

    // Test 5: altın token useSkill ile kullanılamaz
    // İpucu: index 4 altın. Topla, sonra useSkill(ROOM, items.GOLD()) → GoldNotUsable hatası bekle.
    // Bonus: hatadan sonra altın bakiyesinin hâlâ 1 olduğunu kontrol et.
    // function test_useSkill_gold_reverts() public { }
}
