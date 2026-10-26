// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Base} from "./Base.t.sol";
import {SessionEscrow} from "../src/SessionEscrow.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {DevEIP3009Token} from "../src/dev/DevEIP3009Token.sol";

contract SessionEscrowTest is Base {
    function setUp() public {
        _deploy();
    }

    // ------------------------------------------------------------------ open

    function test_open_createsSessionAndConsumesNote() public {
        uint256 before = registry.nextIndex();
        Opened memory o = _open(10e6);
        SessionEscrow.Session memory s = escrow.getSession(o.id);
        assertEq(uint8(s.status), uint8(SessionEscrow.Status.Opened));
        assertEq(s.cap, 10e6);
        assertEq(s.funded, 0);
        assertEq(s.seller, seller);
        assertEq(s.buyer, buyer);
        assertEq(s.sessionKey, sessionKey);
        assertTrue(registry.isSpent(o.nullifier));
        assertEq(registry.nextIndex(), before + 1);
    }

    function test_open_revertsWithoutValidProof() public {
        verifier.set(false);
        uint64 d = uint64(block.timestamp + 1 hours);
        uint256[12] memory p = _pub(70, 10e6, d, bytes32(0), buyer);
        vm.expectRevert(SessionEscrow.InvalidProof.selector);
        _callOpen(p, buyer, seller, d, bytes32(0));
        assertFalse(registry.isSpent(70));
    }

    function test_open_revertsOnUnknownRoot() public {
        uint64 d = uint64(block.timestamp + 1 hours);
        uint256[12] memory p = _pub(1, 10e6, d, bytes32(0), buyer);
        p[0] = 42;
        vm.expectRevert(SessionEscrow.UnknownRoot.selector);
        _callOpen(p, buyer, seller, d, bytes32(0));
    }

    function test_open_revertsOnReplay() public {
        uint64 d = uint64(block.timestamp + 1 hours);
        uint256[12] memory p = _pub(77, 10e6, d, bytes32(0), buyer);
        _callOpen(p, buyer, seller, d, bytes32(0));
        vm.expectRevert(SessionEscrow.NullifierSpent.selector);
        _callOpen(p, buyer, seller, d, bytes32(0));
    }

    function test_open_revertsWhenRevoked() public {
        uint256 key = 999;
        uint64 d = uint64(block.timestamp + 1 hours);
        uint256[12] memory p = _pub(78, 10e6, d, bytes32(0), buyer);
        p[3] = _revocationTag(key);
        registry.revoke(key);
        vm.expectRevert(SessionEscrow.MandateRevoked.selector);
        _callOpen(p, buyer, seller, d, bytes32(0));
    }

    function test_open_revertsOnLookalikeToken() public {
        DevEIP3009Token fake = new DevEIP3009Token();
        uint64 d = uint64(block.timestamp + 1 hours);
        uint256[12] memory p = _pub(79, 10e6, d, bytes32(0), buyer);
        p[7] = uint256(uint160(address(fake)));
        vm.expectRevert(SessionEscrow.TokenNotAllowed.selector);
        _callOpen(p, buyer, seller, d, bytes32(0));
    }

    function test_open_revertsOnStaleProof() public {
        uint64 d = uint64(block.timestamp + 1 hours);
        uint256[12] memory p = _pub(80, 10e6, d, bytes32(0), buyer);
        p[10] = block.timestamp - 301;
        vm.expectRevert(SessionEscrow.StaleProof.selector);
        _callOpen(p, buyer, seller, d, bytes32(0));
    }

    function test_open_revertsOnBadDeadline() public {
        uint64 past = uint64(block.timestamp);
        uint256[12] memory p = _pub(81, 10e6, past, bytes32(0), buyer);
        vm.expectRevert(SessionEscrow.BadDeadline.selector);
        _callOpen(p, buyer, seller, past, bytes32(0));

        uint64 far = uint64(block.timestamp + 8 days);
        p = _pub(81, 10e6, far, bytes32(0), buyer);
        vm.expectRevert(SessionEscrow.BadDeadline.selector);
        _callOpen(p, buyer, seller, far, bytes32(0));
    }

    function test_open_revertsOnSellerMismatch() public {
        uint64 d = uint64(block.timestamp + 1 hours);
        uint256[12] memory p = _pub(82, 10e6, d, bytes32(0), buyer);
        vm.expectRevert(abi.encodeWithSelector(SessionEscrow.SignalMismatch.selector, 6));
        _callOpen(p, buyer, makeAddr("rogue"), d, bytes32(0));
    }

    function test_open_revertsOnCartSwap() public {
        uint64 d = uint64(block.timestamp + 1 hours);
        uint256[12] memory p = _pub(83, 10e6, d, keccak256("cart-a"), buyer);
        vm.expectRevert(abi.encodeWithSelector(SessionEscrow.SignalMismatch.selector, 8));
        _callOpen(p, buyer, seller, d, keccak256("cart-b"));
    }

    function test_open_revertsWhenFrontRunWithOtherBuyer() public {
        uint64 d = uint64(block.timestamp + 1 hours);
        uint256[12] memory p = _pub(84, 10e6, d, bytes32(0), buyer);
        vm.expectRevert(abi.encodeWithSelector(SessionEscrow.SignalMismatch.selector, 9));
        _callOpen(p, makeAddr("attacker"), seller, d, bytes32(0));
    }

    function test_open_revertsOnZeroAmount() public {
        uint64 d = uint64(block.timestamp + 1 hours);
        uint256[12] memory p = _pub(85, 0, d, bytes32(0), buyer);
        vm.expectRevert(SessionEscrow.BadAmount.selector);
        _callOpen(p, buyer, seller, d, bytes32(0));
    }

    // ------------------------------------------------------------------ fund

    function test_markFunded_happyPath() public {
        Opened memory o = _open(10e6);
        _fund(o);
        SessionEscrow.Session memory s = escrow.getSession(o.id);
        assertEq(uint8(s.status), uint8(SessionEscrow.Status.Funded));
        assertEq(s.funded, 10e6);
        assertEq(escrow.locked(address(token)), 10e6);
    }

    function test_markFunded_onlyCoordinator() public {
        Opened memory o = _open(10e6);
        _payViaAuthorization(o.id, o.cap, address(escrow));
        vm.expectRevert(SessionEscrow.NotCoordinator.selector);
        escrow.markFunded(o.id, bytes32(0));
    }

    function test_markFunded_requiresAuthorizationWithSessionNonce() public {
        Opened memory o = _open(10e6);
        // buyer paid, but with some other nonce
        _payViaAuthorization(keccak256("other"), o.cap, address(escrow));
        vm.prank(coordinator);
        vm.expectRevert(SessionEscrow.NotAuthorized.selector);
        escrow.markFunded(o.id, bytes32(0));
    }

    function test_markFunded_requiresBalance() public {
        Opened memory o = _open(10e6);
        // authorization used, but the money went elsewhere
        _payViaAuthorization(o.id, o.cap, makeAddr("elsewhere"));
        vm.prank(coordinator);
        vm.expectRevert(SessionEscrow.InsufficientEscrowBalance.selector);
        escrow.markFunded(o.id, bytes32(0));
    }

    // ------------------------------------------------------------------ close

    function test_close_paysLatestVoucherAndRefundsRest() public {
        Opened memory o = _open(10e6);
        _fund(o);
        uint256 buyerBefore = token.balanceOf(buyer);
        (SessionEscrow.Voucher memory v, bytes memory sig) = _voucher(o.id, 6e6, 3);
        vm.prank(seller);
        escrow.close(o.id, v, sig);
        assertEq(token.balanceOf(seller), 6e6);
        assertEq(token.balanceOf(buyer), buyerBefore + 4e6);
        assertEq(escrow.locked(address(token)), 0);
        assertEq(uint8(escrow.getSession(o.id).status), uint8(SessionEscrow.Status.Closed));
    }

    function test_close_onlySeller() public {
        Opened memory o = _open(10e6);
        _fund(o);
        (SessionEscrow.Voucher memory v, bytes memory sig) = _voucher(o.id, 1e6, 1);
        vm.prank(buyer);
        vm.expectRevert(SessionEscrow.NotSeller.selector);
        escrow.close(o.id, v, sig);
    }

    function test_close_rejectsVoucherFromWrongKey() public {
        Opened memory o = _open(10e6);
        _fund(o);
        SessionEscrow.Voucher memory v =
            SessionEscrow.Voucher({sessionId: o.id, cumulativeAmount: 5e6, callCount: 1, deliveryHashChain: 0});
        (uint8 pv, bytes32 r, bytes32 s) = vm.sign(0xBAD, escrow.voucherDigest(v));
        vm.prank(seller);
        vm.expectRevert(SessionEscrow.BadVoucher.selector);
        escrow.close(o.id, v, abi.encodePacked(r, s, pv));
    }

    function test_close_rejectsVoucherForOtherSession() public {
        Opened memory a = _open(10e6);
        Opened memory b = _open(10e6);
        _fund(a);
        _fund(b);
        (SessionEscrow.Voucher memory v, bytes memory sig) = _voucher(b.id, 5e6, 1);
        vm.prank(seller);
        vm.expectRevert(SessionEscrow.BadVoucher.selector);
        escrow.close(a.id, v, sig);
    }

    function test_close_rejectsOverCap() public {
        Opened memory o = _open(10e6);
        _fund(o);
        (SessionEscrow.Voucher memory v, bytes memory sig) = _voucher(o.id, 10e6 + 1, 9);
        vm.prank(seller);
        vm.expectRevert(SessionEscrow.OverCap.selector);
        escrow.close(o.id, v, sig);
    }

    function test_close_onlyOnce() public {
        Opened memory o = _open(10e6);
        _fund(o);
        (SessionEscrow.Voucher memory v, bytes memory sig) = _voucher(o.id, 1e6, 1);
        vm.startPrank(seller);
        escrow.close(o.id, v, sig);
        vm.expectRevert(SessionEscrow.WrongStatus.selector);
        escrow.close(o.id, v, sig);
        vm.stopPrank();
    }

    function test_close_requiresFunding() public {
        Opened memory o = _open(10e6);
        (SessionEscrow.Voucher memory v, bytes memory sig) = _voucher(o.id, 1e6, 1);
        vm.prank(seller);
        vm.expectRevert(SessionEscrow.WrongStatus.selector);
        escrow.close(o.id, v, sig);
    }

    function test_closeAfterDeadline_notBefore() public {
        Opened memory o = _open(10e6);
        _fund(o);
        SessionEscrow.Voucher memory empty;
        vm.expectRevert(SessionEscrow.DeadlineNotPassed.selector);
        escrow.closeAfterDeadline(o.id, empty, "");
    }

    function test_closeAfterDeadline_noVoucherRefundsAll() public {
        Opened memory o = _open(10e6);
        _fund(o);
        uint256 before = token.balanceOf(buyer);
        vm.warp(o.deadline + 1);
        SessionEscrow.Voucher memory empty;
        escrow.closeAfterDeadline(o.id, empty, "");
        assertEq(token.balanceOf(buyer), before + 10e6);
        assertEq(token.balanceOf(seller), 0);
    }

    function test_closeAfterDeadline_withVoucherPaysSeller() public {
        Opened memory o = _open(10e6);
        _fund(o);
        (SessionEscrow.Voucher memory v, bytes memory sig) = _voucher(o.id, 7e6, 4);
        vm.warp(o.deadline + 1);
        vm.prank(makeAddr("anyone"));
        escrow.closeAfterDeadline(o.id, v, sig);
        assertEq(token.balanceOf(seller), 7e6);
    }

    function test_closeAfterDeadline_refundsUnmarkedFunding() public {
        Opened memory o = _open(10e6);
        _payViaAuthorization(o.id, o.cap, address(escrow)); // HSP paid, coordinator never marked
        uint256 before = token.balanceOf(buyer);
        vm.warp(o.deadline + 1);
        SessionEscrow.Voucher memory empty;
        escrow.closeAfterDeadline(o.id, empty, "");
        assertEq(token.balanceOf(buyer), before + 10e6);
        assertEq(uint8(escrow.getSession(o.id).status), uint8(SessionEscrow.Status.Refunded));
    }

    function test_closeAfterDeadline_unfundedRefundsNothing() public {
        Opened memory o = _open(10e6);
        vm.warp(o.deadline + 1);
        SessionEscrow.Voucher memory empty;
        escrow.closeAfterDeadline(o.id, empty, "");
        assertEq(uint8(escrow.getSession(o.id).status), uint8(SessionEscrow.Status.Refunded));
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_admin_onlyOwner() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        escrow.setTokenAllowed(address(1), true);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_closeConservesFunds(uint128 cap, uint128 used) public {
        cap = uint128(bound(cap, 1, 500_000e6));
        used = uint128(bound(used, 0, cap));
        Opened memory o = _open(cap);
        _fund(o);
        uint256 buyerBefore = token.balanceOf(buyer);
        (SessionEscrow.Voucher memory v, bytes memory sig) = _voucher(o.id, used, 1);
        vm.prank(seller);
        escrow.close(o.id, v, sig);
        uint256 paid = token.balanceOf(seller);
        uint256 refunded = token.balanceOf(buyer) - buyerBefore;
        assertEq(paid, used);
        assertEq(paid + refunded, cap);
        assertLe(paid, cap);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function testFuzz_voucherAboveCapAlwaysReverts(uint128 cap, uint128 over) public {
        cap = uint128(bound(cap, 1, 500_000e6));
        over = uint128(bound(over, 1, type(uint128).max - cap));
        Opened memory o = _open(cap);
        _fund(o);
        (SessionEscrow.Voucher memory v, bytes memory sig) = _voucher(o.id, cap + over, 1);
        vm.prank(seller);
        vm.expectRevert(SessionEscrow.OverCap.selector);
        escrow.close(o.id, v, sig);
    }

    function testFuzz_capEqualsProvenAmount(uint128 amount) public {
        amount = uint128(bound(amount, 1, type(uint128).max));
        Opened memory o = _open(amount);
        assertEq(escrow.getSession(o.id).cap, amount);
    }

    function testFuzz_staleProofRejected(uint256 skew) public {
        skew = bound(skew, 301, 1_000_000);
        uint64 d = uint64(block.timestamp + 1 hours);
        uint256[12] memory p = _pub(5000, 10e6, d, bytes32(0), buyer);
        p[10] = block.timestamp + skew;
        vm.expectRevert(SessionEscrow.StaleProof.selector);
        _callOpen(p, buyer, seller, d, bytes32(0));
    }
}

contract MandateRegistryTest is Base {
    function setUp() public {
        _deploy();
    }

    function test_seal_updatesRootAndKeepsHistory() public {
        uint256 r1 = registry.currentRoot();
        registry.seal(5, "");
        uint256 r2 = registry.currentRoot();
        assertTrue(r1 != r2);
        assertTrue(registry.isKnownRoot(r1));
        assertTrue(registry.isKnownRoot(r2));
        assertFalse(registry.isKnownRoot(0));
    }

    function test_seal_rejectsZeroAndOutOfField() public {
        vm.expectRevert(MandateRegistry.InvalidCommitment.selector);
        registry.seal(0, "");
        vm.expectRevert(MandateRegistry.InvalidCommitment.selector);
        registry.seal(F, "");
    }

    function test_oldRootsExpireAfterHistory() public {
        uint256 r1 = registry.currentRoot();
        for (uint256 i = 0; i < 64; i++) {
            registry.seal(i + 10, "");
        }
        assertFalse(registry.isKnownRoot(r1));
    }

    function test_consume_onlyEscrow() public {
        vm.expectRevert(MandateRegistry.NotEscrow.selector);
        registry.consume(1, 2);
    }

    function test_setEscrow_once() public {
        vm.expectRevert(MandateRegistry.EscrowAlreadySet.selector);
        registry.setEscrow(address(1));
    }

    function test_revoke_marksPoseidonTag() public {
        registry.revoke(42);
        assertTrue(registry.isRevoked(_revocationTag(42)));
        assertFalse(registry.isRevoked(42));
    }

    function testFuzz_nullifierConsumedOnce(uint256 nullifier, uint256 c1, uint256 c2) public {
        c1 = bound(c1, 1, F - 1);
        c2 = bound(c2, 1, F - 1);
        vm.startPrank(address(escrow));
        registry.consume(nullifier, c1);
        vm.expectRevert(MandateRegistry.NullifierAlreadySpent.selector);
        registry.consume(nullifier, c2);
        vm.stopPrank();
    }
}
