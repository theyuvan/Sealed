// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {SessionEscrow, ISpendVerifier} from "../src/SessionEscrow.sol";
import {DevEIP3009Token} from "../src/dev/DevEIP3009Token.sol";
import {PoseidonT2} from "../src/lib/PoseidonT2.sol";

/// Verifier stand-in for unit/fuzz/invariant tests of escrow logic. Real proofs are covered by RealProof.t.sol.
contract MockVerifier is ISpendVerifier {
    bool public result = true;

    function set(bool r) external {
        result = r;
    }

    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[12] calldata)
        external
        view
        returns (bool)
    {
        return result;
    }
}

abstract contract Base is Test {
    uint256 internal constant F = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    MandateRegistry internal registry;
    SessionEscrow internal escrow;
    DevEIP3009Token internal token;
    MockVerifier internal verifier;

    address internal coordinator = makeAddr("coordinator");
    address internal seller = makeAddr("seller");
    uint256 internal buyerPk = 0xB0B;
    address internal buyer;
    uint256 internal sessionKeyPk = 0x5E55;
    address internal sessionKey;
    uint256 internal root;
    uint256 internal nextNullifier = 1000;

    struct Opened {
        bytes32 id;
        uint256 nullifier;
        uint128 cap;
        uint64 deadline;
    }

    function _deploy() internal {
        buyer = vm.addr(buyerPk);
        sessionKey = vm.addr(sessionKeyPk);
        vm.warp(1_800_000_000);
        token = new DevEIP3009Token();
        verifier = new MockVerifier();
        registry = new MandateRegistry();
        escrow = new SessionEscrow(verifier, registry, coordinator, address(this));
        registry.setEscrow(address(escrow));
        escrow.setTokenAllowed(address(token), true);
        registry.seal(123456789, hex"c1");
        root = registry.currentRoot();
        token.mint(buyer, 1_000_000e6);
    }

    function _pub(uint256 nullifier, uint256 amount, uint64 deadline, bytes32 cartHash, address buyer_)
        internal
        view
        returns (uint256[12] memory p)
    {
        p[0] = root;
        p[1] = nullifier;
        p[2] = uint256(keccak256(abi.encode("new", nullifier))) % F;
        p[3] = uint256(keccak256(abi.encode("tag", nullifier))) % F;
        p[4] = amount;
        p[5] = 1;
        p[6] = uint256(uint160(seller));
        p[7] = uint256(uint160(address(token)));
        p[8] = uint256(cartHash) % F;
        p[9] = uint256(escrow.computeSessionId(nullifier, buyer_, seller, deadline)) % F;
        p[10] = block.timestamp;
        p[11] = uint256(uint160(sessionKey));
    }

    function _open(uint256 amount) internal returns (Opened memory o) {
        o.nullifier = nextNullifier++;
        o.deadline = uint64(block.timestamp + 1 hours);
        o.cap = uint128(amount);
        bytes32 cart = keccak256(abi.encode("cart", o.nullifier));
        uint256[12] memory p = _pub(o.nullifier, amount, o.deadline, cart, buyer);
        o.id = _callOpen(p, buyer, seller, o.deadline, cart);
    }

    function _callOpen(uint256[12] memory p, address buyer_, address seller_, uint64 deadline, bytes32 cart)
        internal
        returns (bytes32)
    {
        uint256[2] memory a;
        uint256[2][2] memory b;
        uint256[2] memory c;
        return escrow.open(a, b, c, p, buyer_, seller_, deadline, cart);
    }

    /// Buyer signs EIP-3009 (nonce = sessionId); a relayer (HSP in production) submits it.
    function _payViaAuthorization(bytes32 sessionId, uint256 value, address to) internal {
        bytes32 structHash = keccak256(
            abi.encode(
                token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), buyer, to, value, 0, block.timestamp + 600, sessionId
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, digest);
        token.transferWithAuthorization(buyer, to, value, 0, block.timestamp + 600, sessionId, abi.encodePacked(r, s, v));
    }

    function _fund(Opened memory o) internal {
        _payViaAuthorization(o.id, o.cap, address(escrow));
        vm.prank(coordinator);
        escrow.markFunded(o.id, keccak256(abi.encode("hsp", o.id)));
    }

    function _voucher(bytes32 id, uint128 amount, uint32 calls)
        internal
        view
        returns (SessionEscrow.Voucher memory v, bytes memory sig)
    {
        v = SessionEscrow.Voucher({
            sessionId: id, cumulativeAmount: amount, callCount: calls, deliveryHashChain: keccak256(abi.encode(calls))
        });
        (uint8 pv, bytes32 r, bytes32 s) = vm.sign(sessionKeyPk, escrow.voucherDigest(v));
        sig = abi.encodePacked(r, s, pv);
    }

    function _revocationTag(uint256 key) internal pure returns (uint256) {
        return PoseidonT2.hash([key]);
    }
}
