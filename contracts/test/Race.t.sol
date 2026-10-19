// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Race} from "../src/Race.sol";
import {RaceItems} from "../src/RaceItems.sol";

contract RaceTest is Test {
    Race race;
    RaceItems items;

    address alice = makeAddr("alice"); // makeAddr: isimden sahte bir test adresi üretir
    address bob = makeAddr("bob");

    uint256 raceId; // setUp'ta alice'in başlattığı yarış
    bytes32 seed;

    // Her testten önce çalışır: temiz kontratlar, alice bir yarış başlatır
    function setUp() public {
        vm.warp(1_000_000); // blok zamanını sabit bir değere al (testler öngörülebilir olsun)
        race = new Race();
        items = race.items();
        vm.prank(alice); // bir sonraki çağrıyı alice yapmış gibi
        raceId = race.startRace();
        (,,,,,, seed) = race.races(raceId); // struct'ın son alanı: seed
    }

    // --- Yardımcılar ---

    /// @dev Bu yarışta istenen türden ilk token'ın index'i (testlerde türü bilmek için)
    function _findIndex(uint8 itemType) internal view returns (uint256) {
        for (uint256 i = 0; i < 40; i++) {
            if (race.itemAt(seed, i) == itemType) return i;
        }
        revert("bu tohumda o turden token yok");
    }

    /// @dev Zamanı yarış başından 60 sn sonraya ilerlet: her token artık toplanabilir
    function _waitUntilAllReachable() internal {
        vm.warp(block.timestamp + 60);
    }

    // =====================================================================
    // Benim testlerim
    // =====================================================================

    // Test 1: aynı index iki kez toplanamaz
    function test_collect_sameIndexTwice_reverts() public {
        _waitUntilAllReachable();
        vm.startPrank(alice); // stopPrank'e kadar tüm çağrılar alice'ten

        race.collect(raceId, 0);
        uint256 id = items.tokenId(raceId, race.itemAt(seed, 0));
        assertEq(items.balanceOf(alice, id), 1, "ilk toplama 1 token vermeli");
        assertTrue(race.isCollected(raceId, 0));

        // İkinci deneme AlreadyCollected(raceId, 0) hatasıyla geri dönmeli
        vm.expectRevert(abi.encodeWithSelector(Race.AlreadyCollected.selector, raceId, uint256(0)));
        race.collect(raceId, 0);
        vm.stopPrank();
    }

    // Test 2: itemAt deterministik — aynı girdi her zaman aynı sonuç (fuzz testi:
    // Foundry bu fonksiyonu yüzlerce rastgele seed / index ile çağırır)
    function testFuzz_itemAt_isDeterministic(bytes32 anySeed, uint256 index) public view {
        uint8 first = race.itemAt(anySeed, index);
        assertEq(first, race.itemAt(anySeed, index), "ayni girdi farkli sonuc verdi");
        assertLe(first, 4, "tur 0-4 araliginda olmali");
    }

    // Kontrat, oyunun (src/random.js) hesapladığı türlerle aynı sonucu veriyor mu?
    // Tohum = 1 için beklenen: node ile itemTypeFromHash(itemHash(1, i)), i = 0..9
    function test_itemAt_matchesGame() public view {
        uint8[10] memory fromGame = [2, 0, 3, 0, 4, 0, 0, 0, 0, 3];
        for (uint256 i = 0; i < fromGame.length; i++) {
            assertEq(race.itemAt(bytes32(uint256(1)), i), fromGame[i], "oyun ile kontrat farkli tur hesapliyor");
        }
    }

    // Hile önlemi: uzaktaki bir token yarışın hemen başında toplanamaz
    function test_collect_tooEarly_reverts() public {
        uint256 readyAt = 1_000_000 + race.earliestCollectTime(39);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Race.TooEarly.selector, uint256(39), readyAt));
        race.collect(raceId, 39);

        // Araba oraya varabilecek kadar zaman geçince toplanabilir
        vm.warp(readyAt);
        vm.prank(alice);
        race.collect(raceId, 39);
    }

    // Hile önlemi: başkasının yarışında token toplanamaz
    function test_collect_otherPlayersRace_reverts() public {
        _waitUntilAllReachable();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Race.NotRacePlayer.selector, raceId, bob));
        race.collect(raceId, 0);
    }

    // Hile önlemi: tur imkânsız hızda bitirilemez; bitince toplama kapanır
    function test_finish_rules() public {
        vm.prank(alice);
        vm.expectPartialRevert(Race.FinishTooEarly.selector); // parametreleri ne olursa olsun bu hata
        race.finishRace(raceId);

        _waitUntilAllReachable();
        vm.startPrank(alice);
        race.finishRace(raceId);
        vm.expectRevert(abi.encodeWithSelector(Race.RaceNotActive.selector, raceId));
        race.collect(raceId, 0);
        vm.stopPrank();
    }

    // Hile önlemi: süresi dolan yarışta toplama yok
    function test_collect_afterExpiry_reverts() public {
        vm.warp(block.timestamp + race.MAX_DURATION() + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Race.RaceNotActive.selector, raceId));
        race.collect(raceId, 0);
    }

    // Kuralları atlayıp doğrudan token basılamaz: sadece Race mint edebilir
    function test_items_onlyRaceCanMint() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RaceItems.NotMinter.selector, alice));
        items.mint(alice, raceId, 4);
    }

    // =====================================================================
    // SENİN TESTLERİN (aşağıdaki üçünü sen yaz; ipuçları yorumlarda)
    // Hazır yardımcılar: _waitUntilAllReachable(), _findIndex(tür), race.collect, race.useSkill
    // =====================================================================

    // Test 3: transfer revert eder (birlikte kurduk)
    // Hazırla: alice bir token toplasın → Yap: bob'a göndermeyi dene → Doğrula: hata + bakiyeler aynı
    function test_transfer_reverts() public {
        _waitUntilAllReachable(); // tokenlar toplanabilir olsun

        vm.prank(alice); // yarışın sahibi alice: çağrıyı o yapmalı
        race.collect(raceId, 0);
        uint256 id = items.tokenId(raceId, race.itemAt(seed, 0));

        // Sıra: önce çağıran (prank), sonra beklenen hata, en son asıl çağrı
        vm.prank(alice);
        vm.expectRevert(RaceItems.NonTransferable.selector);
        items.safeTransferFrom(alice, bob, id, 1, "");

        assertEq(items.balanceOf(alice, id), 1, "alice'in tokeni yerinde kalmali");
        assertEq(items.balanceOf(bob, id), 0, "bob'a token gecmemeli");
    }

    // Test 4: useSkill token'ı yakar, olmayan token için revert eder
    // Hazırla: alice bir Mıknatıs toplasın → Yap 1: kullan → Doğrula: yakıldı → Yap 2: tekrar kullan → hata
    function test_useSkill_burns_and_revertsWhenEmpty() public {
        uint8 magnet = 2;
        _waitUntilAllReachable();
        vm.startPrank(alice); // stopPrank'e kadar tüm çağrılar alice'ten

        race.collect(raceId, _findIndex(magnet));
        uint256 id = items.tokenId(raceId, magnet);
        assertEq(items.balanceOf(alice, id), 1, "miknatis toplanmis olmali");

        // Yap 1: kullan → token yakılmalı (bakiye 1 → 0)
        race.useSkill(raceId, magnet);
        assertEq(items.balanceOf(alice, id), 0, "useSkill tokeni yakmali");

        // Yap 2: elinde kalmadı → NoItem(raceId, 2). Tür uint8 olmalı: hata tanımı (uint256, uint8)
        vm.expectRevert(abi.encodeWithSelector(Race.NoItem.selector, raceId, magnet));
        race.useSkill(raceId, magnet);

        vm.stopPrank();
    }

    // Test 5: altın token useSkill ile kullanılamaz
    // Hazırla: alice bir Altın toplasın → Yap: kullanmayı dene → Doğrula: GoldNotUsable + altın yerinde
    function test_useSkill_gold_reverts() public {
        uint8 gold = 4;
        _waitUntilAllReachable();
        vm.startPrank(alice);

        race.collect(raceId, _findIndex(gold));
        uint256 id = items.tokenId(raceId, gold);

        vm.expectRevert(Race.GoldNotUsable.selector); // parametresiz hata: sadece selector
        race.useSkill(raceId, gold);

        // Bonus: hata işlemi tamamen geri aldığı için altın hâlâ alice'te
        assertEq(items.balanceOf(alice, id), 1, "altin yakilmamali");

        vm.stopPrank();
    }
}
