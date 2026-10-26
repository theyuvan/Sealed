// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Base} from "../Base.t.sol";
import {SessionEscrow} from "../../src/SessionEscrow.sol";
import {DevEIP3009Token} from "../../src/dev/DevEIP3009Token.sol";

/// Drives the escrow through random open / fund / close / attack sequences and records ghost state.
contract Handler is Base {
    bytes32[] public ids;
    mapping(bytes32 => uint128) public provenAmount;
    mapping(bytes32 => uint256) public paid;
    mapping(bytes32 => uint256) public refunded;
    mapping(bytes32 => bool) public settled;

    uint256 public ghostReplaySuccess;
    uint256 public ghostInvalidProofSuccess;
    uint256 public ghostRevokedSuccess;
    uint256 public ghostWrongTokenSuccess;
    uint256 public ghostOverCapSuccess;

    uint256[] internal usedNullifiers;
    DevEIP3009Token internal fake;

    constructor() {
        _deploy();
        fake = new DevEIP3009Token();
        registry.revoke(31337); // a revoked mandate for the attack action
    }

    // ------------------------------------------------------------------ honest actions

    function open(uint128 amount) external {
        amount = uint128(bound(amount, 1, 50_000e6));
        Opened memory o = _open(amount);
        ids.push(o.id);
        provenAmount[o.id] = amount;
        usedNullifiers.push(o.nullifier);
    }

    function fund(uint256 i) external {
        if (ids.length == 0) return;
        bytes32 id = ids[i % ids.length];
        SessionEscrow.Session memory s = escrow.getSession(id);
        if (s.status != SessionEscrow.Status.Opened || block.timestamp > s.deadline) return;
        _fund(Opened({id: id, nullifier: s.nullifier, cap: s.cap, deadline: s.deadline}));
    }

    function close(uint256 i, uint128 used) external {
        if (ids.length == 0) return;
        bytes32 id = ids[i % ids.length];
        SessionEscrow.Session memory s = escrow.getSession(id);
        if (s.status != SessionEscrow.Status.Funded) return;
        used = uint128(bound(used, 0, s.cap));
        (SessionEscrow.Voucher memory v, bytes memory sig) = _voucher(id, used, 1);
        _settleAndRecord(id, s, v, sig, false);
    }

    function closeLate(uint256 i, uint128 used, bool withVoucher) external {
        if (ids.length == 0) return;
        bytes32 id = ids[i % ids.length];
        SessionEscrow.Session memory s = escrow.getSession(id);
        if (s.status != SessionEscrow.Status.Funded && s.status != SessionEscrow.Status.Opened) return;
        if (block.timestamp <= s.deadline) vm.warp(s.deadline + 1);
        SessionEscrow.Voucher memory v;
        bytes memory sig;
        if (withVoucher && s.status == SessionEscrow.Status.Funded) (v, sig) = _voucher(id, uint128(bound(used, 0, s.cap)), 1);
        _settleAndRecord(id, s, v, sig, true);
    }

    function _settleAndRecord(bytes32 id, SessionEscrow.Session memory s, SessionEscrow.Voucher memory v, bytes memory sig, bool late) internal {
        uint256 sellerBefore = token.balanceOf(seller);
        uint256 buyerBefore = token.balanceOf(buyer);
        if (late) {
            escrow.closeAfterDeadline(id, v, sig);
        } else {
            vm.prank(seller);
            escrow.close(id, v, sig);
        }
        if (s.status == SessionEscrow.Status.Funded) {
            paid[id] = token.balanceOf(seller) - sellerBefore;
            refunded[id] = token.balanceOf(buyer) - buyerBefore;
            settled[id] = true;
        }
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 2 hours));
        root = registry.currentRoot();
    }

    // ------------------------------------------------------------------ attacks (must never succeed)

    function replay(uint256 i) external {
        if (usedNullifiers.length == 0) return;
        uint256 n = usedNullifiers[i % usedNullifiers.length];
        uint64 d = uint64(block.timestamp + 1 hours);
        uint256[12] memory p = _pub(n, 1e6, d, bytes32(0), buyer);
        try this.callOpen(p, d) {
            ghostReplaySuccess++;
        } catch {}
    }

    function openWithInvalidProof(uint128 amount) external {
        verifier.set(false);
        uint64 d = uint64(block.timestamp + 1 hours);
        uint256[12] memory p = _pub(nextNullifier++, uint128(bound(amount, 1, 1e12)), d, bytes32(0), buyer);
        try this.callOpen(p, d) {
            ghostInvalidProofSuccess++;
        } catch {}
        verifier.set(true);
    }

    function openRevoked() external {
        uint64 d = uint64(block.timestamp + 1 hours);
        uint256[12] memory p = _pub(nextNullifier++, 1e6, d, bytes32(0), buyer);
        p[3] = _revocationTag(31337);
        try this.callOpen(p, d) {
            ghostRevokedSuccess++;
        } catch {}
    }

    function openWrongToken() external {
        uint64 d = uint64(block.timestamp + 1 hours);
        uint256[12] memory p = _pub(nextNullifier++, 1e6, d, bytes32(0), buyer);
        p[7] = uint256(uint160(address(fake)));
        try this.callOpen(p, d) {
            ghostWrongTokenSuccess++;
        } catch {}
    }

    function closeOverCap(uint256 i, uint128 extra) external {
        if (ids.length == 0) return;
        bytes32 id = ids[i % ids.length];
        SessionEscrow.Session memory s = escrow.getSession(id);
        if (s.status != SessionEscrow.Status.Funded) return;
        (SessionEscrow.Voucher memory v, bytes memory sig) = _voucher(id, s.cap + uint128(bound(extra, 1, 1e12)), 1);
        vm.prank(seller);
        try escrow.close(id, v, sig) {
            ghostOverCapSuccess++;
        } catch {}
    }

    function callOpen(uint256[12] memory p, uint64 d) external returns (bytes32) {
        require(msg.sender == address(this));
        return _callOpen(p, buyer, seller, d, bytes32(0));
    }

    // ------------------------------------------------------------------ views for invariants

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function escrowContract() external view returns (SessionEscrow) {
        return escrow;
    }

    function tokenContract() external view returns (DevEIP3009Token) {
        return token;
    }
}

contract EscrowInvariantTest is Base {
    Handler internal h;

    function setUp() public {
        h = new Handler();
        targetContract(address(h));
        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = Handler.open.selector;
        selectors[1] = Handler.fund.selector;
        selectors[2] = Handler.close.selector;
        selectors[3] = Handler.closeLate.selector;
        selectors[4] = Handler.warp.selector;
        selectors[5] = Handler.replay.selector;
        selectors[6] = Handler.openWithInvalidProof.selector;
        selectors[7] = Handler.openRevoked.selector;
        selectors[8] = Handler.openWrongToken.selector;
        selectors[9] = Handler.closeOverCap.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: selectors}));
    }

    function invariant_nullifierConsumedOnce() public view {
        assertEq(h.ghostReplaySuccess(), 0);
    }

    function invariant_noSessionWithoutValidProof() public view {
        assertEq(h.ghostInvalidProofSuccess(), 0);
    }

    function invariant_revokedMandateCannotOpen() public view {
        assertEq(h.ghostRevokedSuccess(), 0);
    }

    function invariant_onlyPinnedToken() public view {
        assertEq(h.ghostWrongTokenSuccess(), 0);
        SessionEscrow e = h.escrowContract();
        for (uint256 i = 0; i < h.idsLength(); i++) {
            assertEq(e.getSession(h.ids(i)).token, address(h.tokenContract()));
        }
    }

    function invariant_paidPlusRefundedEqualsFunded_andPaidLeCap() public view {
        SessionEscrow e = h.escrowContract();
        assertEq(h.ghostOverCapSuccess(), 0);
        for (uint256 i = 0; i < h.idsLength(); i++) {
            bytes32 id = h.ids(i);
            SessionEscrow.Session memory s = e.getSession(id);
            assertEq(s.cap, h.provenAmount(id), "cap == proven amount");
            assertLe(s.funded, s.cap);
            if (h.settled(id)) {
                assertEq(h.paid(id) + h.refunded(id), s.funded, "paid + refunded == funded");
                assertLe(h.paid(id), s.cap, "paid <= cap");
            }
        }
    }

    function invariant_escrowSolvent() public view {
        SessionEscrow e = h.escrowContract();
        DevEIP3009Token t = h.tokenContract();
        uint256 sumFunded;
        for (uint256 i = 0; i < h.idsLength(); i++) {
            SessionEscrow.Session memory s = e.getSession(h.ids(i));
            if (s.status == SessionEscrow.Status.Funded) sumFunded += s.funded;
        }
        assertEq(e.locked(address(t)), sumFunded, "locked tracks open funded sessions");
        assertGe(t.balanceOf(address(e)), sumFunded, "escrow balance >= sum of open funded sessions");
    }
}
