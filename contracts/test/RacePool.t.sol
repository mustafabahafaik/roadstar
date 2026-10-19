// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {RacePool} from "../src/RacePool.sol";

contract RacePoolTest is Test {
    RacePool pool;

    // Sunucunun imza anahtarı (testte sabit bir sayı; gerçeği server/.env'de durur)
    uint256 constant SIGNER_KEY = 0xA11CE;
    address signer;
    address treasury = makeAddr("treasury");

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    uint256 constant FEE = 1 ether; // 1 MON (testte birim adı "ether", değer aynı: 10^18 wei)
    uint256 roomId; // setUp'ta açılan 3 kişilik oda

    function setUp() public {
        vm.warp(1_000_000);
        signer = vm.addr(SIGNER_KEY); // özel anahtardan adres
        pool = new RacePool(signer, treasury);
        for (uint256 i = 0; i < 3; i++) vm.deal([alice, bob, carol][i], 10 ether); // test parası ver
        roomId = pool.createRoom(FEE, 3);
    }

    // --- Yardımcılar ---

    function _join(address player) internal {
        vm.prank(player);
        pool.joinRoom{value: FEE}(roomId); // {value: ...}: işlemle birlikte para gönder
    }

    function _fillRoom() internal {
        _join(alice);
        _join(bob);
        _join(carol);
    }

    function _ranking(address a, address b, address c) internal pure returns (address[] memory r) {
        r = new address[](3);
        r[0] = a;
        r[1] = b;
        r[2] = c;
    }

    /// @dev Sunucunun yaptığının aynısı: özet → "\x19Ethereum Signed Message:\n32" öneki → imza.
    ///      ethers'ta: wallet.signMessage(getBytes(hash))
    function _sign(uint256 key, uint256 id, address[] memory ranking) internal view returns (bytes memory) {
        bytes32 hash = keccak256(abi.encode(block.chainid, address(pool), id, ranking));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, MessageHashUtils.toEthSignedMessageHash(hash));
        return abi.encodePacked(r, s, v); // 65 bayt: r (32) + s (32) + v (1)
    }

    // =====================================================================
    // Benim testlerim
    // =====================================================================

    // Test 1: tam akış — 3 kişi girer, sıralama imzalanır, %80 / %15 / %5 dağılır, kazanan çeker
    function test_fullFlow_paysRanking() public {
        _fillRoom();
        (,,, uint64 startedAt,, address[] memory players) = pool.getRoom(roomId);
        assertGt(startedAt, 0, "oda dolunca baslamali");
        assertEq(players.length, 3);
        assertEq(address(pool).balance, 3 ether, "ucretler kontratta kilitli");

        // bob 1., carol 2., alice 3. Herkes settle edebilir (yetki imzadan gelir): alice çağırsın
        address[] memory ranking = _ranking(bob, carol, alice);
        vm.prank(alice);
        pool.settle(roomId, ranking, _sign(SIGNER_KEY, roomId, ranking));

        assertEq(pool.claimable(bob), 2.4 ether, "1. pot'un %80'i");
        assertEq(pool.claimable(carol), 0.45 ether, "2. pot'un %15'i");
        assertEq(pool.claimable(treasury), 0.15 ether, "treasury %5");
        assertEq(pool.claimable(alice), 0, "3. bir sey almaz");

        // Pull: para ancak withdraw ile çıkar
        uint256 before = bob.balance;
        vm.prank(bob);
        pool.withdraw();
        assertEq(bob.balance - before, 2.4 ether);
        assertEq(pool.claimable(bob), 0, "cekince alacak sifirlanir");

        vm.prank(bob);
        vm.expectRevert(RacePool.NothingToWithdraw.selector);
        pool.withdraw(); // ikinci çekiş: alacak yok
    }

    // Test 2: sahte imza — başka bir anahtarla imzalanmış ya da imzadan sonra değiştirilmiş sıralama
    function test_settle_rejectsForgedSignature() public {
        _fillRoom();
        address[] memory ranking = _ranking(alice, bob, carol);

        // a) Hileci kendi anahtarıyla "alice 1." imzalar
        bytes memory forged = _sign(0xBAD, roomId, ranking);
        vm.expectRevert(RacePool.InvalidSignature.selector);
        pool.settle(roomId, ranking, forged);

        // b) Gerçek imza "bob 1." için; carol imzayı alıp sıralamayı kendi lehine çevirir
        bytes memory real = _sign(SIGNER_KEY, roomId, _ranking(bob, alice, carol));
        vm.expectRevert(RacePool.InvalidSignature.selector);
        pool.settle(roomId, _ranking(carol, alice, bob), real);

        // c) Başka bir odanın imzası bu odada geçmez (roomId özetin içinde)
        bytes memory otherRoom = _sign(SIGNER_KEY, roomId + 1, ranking);
        vm.expectRevert(RacePool.InvalidSignature.selector);
        pool.settle(roomId, ranking, otherRoom);
    }

    // Test 3: tekrarlı sıralama — imza GERÇEK olsa bile (sunucu hatası) bob iki kez yazılamaz
    function test_settle_rejectsDuplicateInRanking() public {
        _fillRoom();
        address[] memory ranking = _ranking(bob, bob, alice); // carol yok, bob iki ödül alırdı
        bytes memory sig = _sign(SIGNER_KEY, roomId, ranking);
        vm.expectRevert(abi.encodeWithSelector(RacePool.DuplicatePlayer.selector, bob));
        pool.settle(roomId, ranking, sig);
    }

    // Ek: odada olmayan biri sıralamaya giremez; oda dolmadan settle olmaz; aynı kişi iki kez giremez
    function test_settle_rejectsOutsiderAndEarly() public {
        _join(alice);
        _join(bob);
        address[] memory ranking = _ranking(alice, bob, carol);
        vm.expectRevert(abi.encodeWithSelector(RacePool.RoomNotStarted.selector, roomId));
        pool.settle(roomId, ranking, _sign(SIGNER_KEY, roomId, ranking));

        vm.expectRevert(abi.encodeWithSelector(RacePool.AlreadyJoined.selector, roomId, alice));
        _join(alice);

        _join(carol);
        address dave = makeAddr("dave");
        address[] memory withDave = _ranking(dave, alice, bob);
        vm.expectRevert(abi.encodeWithSelector(RacePool.NotInRoom.selector, roomId, dave));
        pool.settle(roomId, withDave, _sign(SIGNER_KEY, roomId, withDave));
    }

    // =====================================================================
    // Senin testlerin (vm.skip: yazana kadar "atlandı" görünür, yanlışlıkla "geçti" sanılmaz)
    // Yazınca vm.skip satırını sil.
    // =====================================================================

    // Test 4: aynı oda iki kez settle edilemez
    // İpucu: odayı doldur, geçerli imzayla bir kez settle et, ikinci çağrıda
    //        AlreadySettled(roomId) bekle (Test 3'teki expectRevert + abi.encodeWithSelector kalıbı)
    function test_settle_twice_reverts() public {
        vm.skip(true, "TODO: Mustafa yazacak");
    }

    // Test 5: yanlış ücretle katılınamaz
    // İpucu: pool.joinRoom{value: 0.5 ether}(roomId) → WrongFee(gönderilen, beklenen).
    //        Fazlası da (2 ether) reddedilmeli. vm.prank'i unutma
    function test_join_wrongFee_reverts() public {
        vm.skip(true, "TODO: Mustafa yazacak");
    }

    // Test 6: oda 10 dakikada dolmazsa iade
    // İpucu: sadece alice ve bob girsin. Önce iade denemesi RefundNotAvailable vermeli.
    //        vm.warp(block.timestamp + pool.JOIN_WINDOW()) ile zamanı ilerlet, alice iade alsın:
    //        bakiyesi FEE kadar artmalı, ikinci iade NotInRoom vermeli, carol artık giremez (JoinWindowClosed)
    function test_refund_afterJoinWindow() public {
        vm.skip(true, "TODO: Mustafa yazacak");
    }
}
