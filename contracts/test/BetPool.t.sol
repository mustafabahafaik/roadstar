// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {RacePool} from "../src/RacePool.sol";
import {BetPool, IRacePool} from "../src/BetPool.sol";

/// @dev Parayı reddeden izleyici (ör. receive'i olmayan bir kontrat): payout onu atlayıp devam etmeli
contract RejectingBettor {
    bool public accept;

    function bet(BetPool pool, uint256 roomId, address racer) external payable {
        pool.placeBet{value: msg.value}(roomId, racer);
    }

    function setAccept(bool on) external {
        accept = on;
    }

    function claim(BetPool pool) external {
        pool.claim();
    }

    receive() external payable {
        require(accept, "para istemiyorum");
    }
}

contract BetPoolTest is Test {
    RacePool race;
    BetPool bets;

    uint256 constant SIGNER_KEY = 0xA11CE;
    address signer;
    address alice = makeAddr("alice"); // yarışçılar
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address[6] fans; // izleyiciler
    uint256 roomId;
    uint64 deadline;
    uint256 constant BET = 0.01 ether;

    function setUp() public {
        vm.warp(1_000_000);
        signer = vm.addr(SIGNER_KEY);
        race = new RacePool(signer, makeAddr("treasury"));
        bets = new BetPool(IRacePool(address(race)), signer);

        // 3 kişilik RacePool odası doldu (başladı)
        roomId = race.createRoom(0.05 ether, 3);
        address[3] memory racers = [alice, bob, carol];
        for (uint256 i = 0; i < 3; i++) {
            vm.deal(racers[i], 1 ether);
            vm.prank(racers[i]);
            race.joinRoom{value: 0.05 ether}(roomId);
        }
        for (uint256 i = 0; i < fans.length; i++) {
            fans[i] = makeAddr(string.concat("fan", vm.toString(i)));
            vm.deal(fans[i], 1 ether);
        }
        deadline = uint64(block.timestamp + 30);
        vm.prank(signer);
        bets.openBets(roomId, deadline);
    }

    // --- Yardımcılar ---

    function _bet(address fan, address racer) internal {
        vm.prank(fan);
        bets.placeBet{value: BET}(roomId, racer);
    }

    function _sign(uint256 key, uint256 id, address winner) internal view returns (bytes memory) {
        bytes32 hash = keccak256(abi.encode("BET", block.chainid, address(bets), id, winner));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, MessageHashUtils.toEthSignedMessageHash(hash));
        return abi.encodePacked(r, s, v);
    }

    function _settle(address winner) internal {
        vm.warp(deadline + 1);
        bets.settleBets(roomId, winner, _sign(SIGNER_KEY, roomId, winner));
    }

    // =====================================================================
    // İstenen testler
    // =====================================================================

    // 1) Kapanıştan sonra bahis yok (deadline anı dahil açık, bir saniye sonrası kapalı)
    function test_placeBet_afterDeadline_reverts() public {
        vm.warp(deadline);
        _bet(fans[0], alice); // son saniye: geçer
        vm.warp(deadline + 1);
        vm.prank(fans[1]);
        vm.expectRevert(abi.encodeWithSelector(BetPool.BetsClosed.selector, roomId));
        bets.placeBet{value: BET}(roomId, alice);
    }

    // 2) Kişi başı tek bahis (başka yarışçıya da olsa)
    function test_placeBet_twice_reverts() public {
        _bet(fans[0], alice);
        vm.prank(fans[0]);
        vm.expectRevert(abi.encodeWithSelector(BetPool.AlreadyBet.selector, roomId, fans[0]));
        bets.placeBet{value: BET}(roomId, bob);
    }

    // 3) Odada olmayana bahis yok (yarışçılar openBets'te RacePool.getRoom'dan okundu)
    function test_placeBet_notARacer_reverts() public {
        address dave = makeAddr("dave");
        vm.prank(fans[0]);
        vm.expectRevert(abi.encodeWithSelector(BetPool.NotARacer.selector, dave));
        bets.placeBet{value: BET}(roomId, dave);
    }

    // 4) Sahte imza: başka anahtar, ya da gerçek imza ama başka kazanan
    function test_settle_forgedSignature_reverts() public {
        _bet(fans[0], alice);
        vm.warp(deadline + 1);
        vm.expectRevert(BetPool.InvalidSignature.selector);
        bets.settleBets(roomId, alice, _sign(0xBAD, roomId, alice));

        bytes memory realForBob = _sign(SIGNER_KEY, roomId, bob);
        vm.expectRevert(BetPool.InvalidSignature.selector);
        bets.settleBets(roomId, alice, realForBob);
    }

    // 5) Oran ve paylaşım: 3 kişi alice'e, 1 kişi bob'a, 1 kişi carol'a → havuz 0.05, alice kazanır.
    //    Oran = 0.05 / 0.03 ≈ 1.67x; her kazanan 0.05 / 3 alır; kaybedenler bir şey almaz
    function test_oddsAndPayout() public {
        _bet(fans[0], alice);
        _bet(fans[1], alice);
        _bet(fans[2], alice);
        _bet(fans[3], bob);
        _bet(fans[4], carol);
        (,,,, uint256 betCount,, uint32[] memory counts) = bets.getBook(roomId);
        assertEq(betCount, 5);
        assertEq(counts[0], 3, "alice'e 3 bahis");
        assertEq(counts[1], 1);

        _settle(alice);
        uint256 share = (5 * BET) / 3;
        uint256[5] memory before;
        for (uint256 i = 0; i < 5; i++) before[i] = fans[i].balance;
        bets.payout(roomId, 0, 50);
        for (uint256 i = 0; i < 3; i++) assertEq(fans[i].balance - before[i], share, "kazanan payi");
        assertEq(fans[3].balance, before[3], "kaybeden bir sey almaz");
        assertEq(fans[4].balance, before[4]);
        assertLe(address(bets).balance, 2, "havuz dagitildi (sadece bolme artigi wei)");
        (, bool settled,, address winner,,,) = bets.getBook(roomId);
        assertTrue(settled);
        assertEq(winner, alice);
    }

    // 6) Kimse bilemedi: herkes bob'a yatırdı, alice kazandı → herkese iade (kazanan yoksa, 0 adres, de aynı yol)
    function test_nobodyRight_refundsAll() public {
        _bet(fans[0], bob);
        _bet(fans[1], bob);
        _settle(alice);
        uint256 before0 = fans[0].balance;
        bets.payout(roomId, 0, 50);
        assertEq(fans[0].balance - before0, BET, "iade");
        assertEq(address(bets).balance, 0);
    }

    // 7) payout iki kez ödemez (aynı aralık, üst üste binen aralık)
    function test_payout_twice_paysOnce() public {
        for (uint256 i = 0; i < 4; i++) _bet(fans[i], alice);
        _settle(alice);
        bets.payout(roomId, 0, 2);
        uint256 afterFirst = fans[0].balance;
        bets.payout(roomId, 0, 2); // aynı parti tekrar
        bets.payout(roomId, 1, 3); // üst üste binen
        assertEq(fans[0].balance, afterFirst, "ikinci kez odenmedi");
        assertEq(fans[3].balance, 1 ether, "son kisi de bir kez odendi"); // 4 kişi de alice'e: pay = yatırdığı
        assertEq(address(bets).balance, 0);
    }

    // 8) Parayı reddeden bir alıcı diğerlerini engellemez: onun payı alacağa yazılır
    function test_failedReceiver_doesNotBlock() public {
        RejectingBettor rejector = new RejectingBettor();
        rejector.bet{value: BET}(bets, roomId, alice);
        _bet(fans[0], alice);
        _bet(fans[1], bob);
        _settle(alice);
        uint256 before0 = fans[0].balance;
        bets.payout(roomId, 0, 50);
        uint256 share = (3 * BET) / 2;
        assertEq(fans[0].balance - before0, share, "arkadaki kazanan odendi");
        assertEq(bets.claimable(address(rejector)), share, "reddedenin payi alacakta");
    }

    // =====================================================================
    // Ek kontroller
    // =====================================================================

    function test_openBets_onlyOperator_andStartedRoom() public {
        vm.expectRevert(BetPool.NotOperator.selector);
        bets.openBets(roomId + 1, deadline);

        uint256 emptyRoom = race.createRoom(0.05 ether, 2); // kimse girmedi: başlamadı
        vm.prank(signer);
        vm.expectRevert(abi.encodeWithSelector(BetPool.RoomNotStarted.selector, emptyRoom));
        bets.openBets(emptyRoom, deadline);

        vm.prank(signer);
        vm.expectRevert(abi.encodeWithSelector(BetPool.AlreadyOpen.selector, roomId));
        bets.openBets(roomId, deadline);
    }

    function test_placeBet_wrongAmount_andSettleTooEarly() public {
        vm.prank(fans[0]);
        vm.expectRevert(abi.encodeWithSelector(BetPool.WrongAmount.selector, 0.02 ether, BET));
        bets.placeBet{value: 0.02 ether}(roomId, alice);

        _bet(fans[0], alice);
        bytes memory sig = _sign(SIGNER_KEY, roomId, alice);
        vm.expectRevert(abi.encodeWithSelector(BetPool.BetsStillOpen.selector, roomId));
        bets.settleBets(roomId, alice, sig); // bahis sürerken sonuç yazılamaz
    }

    function test_expire_refundsAfterOneDay() public {
        _bet(fans[0], alice);
        vm.warp(deadline + 1 days);
        vm.expectRevert(abi.encodeWithSelector(BetPool.NotExpired.selector, roomId));
        bets.expire(roomId);
        vm.warp(deadline + 1 days + 1);
        bets.expire(roomId); // sunucu sonucu yazmadı: herkes çağırabilir
        uint256 before0 = fans[0].balance;
        bets.payout(roomId, 0, 50);
        assertEq(fans[0].balance - before0, BET);
    }

    function test_airdrop_splitsAndRefundsFailed() public {
        RejectingBettor rejector = new RejectingBettor();
        address[] memory to = new address[](3);
        to[0] = makeAddr("yeni1");
        to[1] = address(rejector); // reddeder: payı gönderene döner
        to[2] = makeAddr("yeni2");
        address faucet = makeAddr("faucet");
        vm.deal(faucet, 1 ether);
        vm.prank(faucet);
        bets.airdrop{value: 0.075 ether}(to);
        assertEq(to[0].balance, 0.025 ether);
        assertEq(to[2].balance, 0.025 ether);
        assertEq(faucet.balance, 1 ether - 0.05 ether, "reddedilen pay geri geldi");
    }

    // =====================================================================
    // Senin testin (vm.skip: yazana kadar "atlandı" görünür). Yazınca vm.skip satırını sil.
    // =====================================================================

    // claim: payout'ta gönderilemeyen pay sonradan çekilebilmeli, iki kez çekilememeli
    // İpucu: test_failedReceiver_doesNotBlock gibi kur (rejector alice'e yatırsın, alice kazansın, payout).
    //        Sonra rejector.setAccept(true); rejector.claim(bets) → bakiyesi pay kadar artmalı,
    //        claimable sıfırlanmalı; ikinci rejector.claim(bets) NothingToClaim ile revert etmeli
    //        (vm.expectRevert(BetPool.NothingToClaim.selector))
    function test_claim_afterDeferredPayout() public {
        vm.skip(true);
    }
}
