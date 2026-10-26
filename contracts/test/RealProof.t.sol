// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {SessionEscrow, ISpendVerifier} from "../src/SessionEscrow.sol";
import {SpendVerifier} from "../src/SpendVerifier.sol";
import {DevEIP3009Token} from "../src/dev/DevEIP3009Token.sol";
import {PoseidonT2} from "../src/lib/PoseidonT2.sol";
import {PoseidonT3} from "../src/lib/PoseidonT3.sol";

/// End-to-end contract checks with REAL Groth16 proofs from circuits/scripts/gen-fixtures.ts and the
/// generated SpendVerifier. Also proves the JS Merkle/Poseidon mirror equals the on-chain tree.
contract RealProofTest is Test {
    using stdJson for string;

    string internal fx;
    DevEIP3009Token internal token;
    SpendVerifier internal verifier;
    MandateRegistry internal registry;
    SessionEscrow internal escrow;
    address internal coordinator = makeAddr("coordinator");

    struct P {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
        uint256[12] pub;
        bytes32 cartHash;
        bytes32 sessionId;
        uint64 deadline;
        uint128 amount;
    }

    function setUp() public {
        fx = vm.readFile("test/fixtures/spend.json");
        address deployer = fx.readAddress(".deployer");
        vm.chainId(fx.readUint(".chainId"));
        vm.warp(fx.readUint(".now"));

        vm.startPrank(deployer);
        token = new DevEIP3009Token(); // nonce 0
        verifier = new SpendVerifier(); // nonce 1
        registry = new MandateRegistry(); // nonce 2
        escrow = new SessionEscrow(ISpendVerifier(address(verifier)), registry, coordinator, deployer); // nonce 3
        registry.setEscrow(address(escrow));
        escrow.setTokenAllowed(address(token), true);
        token.mint(fx.readAddress(".buyer"), 100e6);
        vm.stopPrank();

        assertEq(address(token), fx.readAddress(".token"), "fixture token address drifted; regenerate fixtures");
        assertEq(address(escrow), fx.readAddress(".escrow"), "fixture escrow address drifted; regenerate fixtures");
    }

    function _load(string memory key) internal view returns (P memory p) {
        uint256[] memory a = fx.readUintArray(string.concat(".", key, ".a"));
        uint256[] memory c = fx.readUintArray(string.concat(".", key, ".c"));
        uint256[] memory b0 = fx.readUintArray(string.concat(".", key, ".b[0]"));
        uint256[] memory b1 = fx.readUintArray(string.concat(".", key, ".b[1]"));
        uint256[] memory pub = fx.readUintArray(string.concat(".", key, ".pub"));
        p.a = [a[0], a[1]];
        p.c = [c[0], c[1]];
        p.b = [[b0[0], b0[1]], [b1[0], b1[1]]];
        for (uint256 i = 0; i < 12; i++) {
            p.pub[i] = pub[i];
        }
        p.cartHash = fx.readBytes32(string.concat(".", key, ".cartHash"));
        p.sessionId = fx.readBytes32(string.concat(".", key, ".sessionId"));
        p.deadline = uint64(fx.readUint(string.concat(".", key, ".deadline")));
        p.amount = uint128(fx.readUint(string.concat(".", key, ".amount")));
    }

    function _open(P memory p) internal returns (bytes32) {
        return escrow.open(p.a, p.b, p.c, p.pub, fx.readAddress(".buyer"), fx.readAddress(".seller"), p.deadline, p.cartHash);
    }

    function _seal() internal {
        registry.seal(fx.readUint(".commitment0"), hex"aa");
    }

    function test_poseidonMatchesCircomlib() public view {
        assertEq(PoseidonT3.hash([uint256(1), uint256(2)]), fx.readUint(".poseidon12"));
        assertEq(PoseidonT2.hash([uint256(1)]), fx.readUint(".poseidon1"));
    }

    function test_treeMatchesJsMirror() public {
        assertEq(registry.currentRoot(), fx.readUint(".emptyRoot"));
        _seal();
        assertEq(registry.currentRoot(), fx.readUint(".rootAfterSeal"));
    }

    function test_verifierAcceptsRealProof() public view {
        P memory p = _load("first");
        assertTrue(verifier.verifyProof(p.a, p.b, p.c, p.pub));
        p.pub[4] += 1;
        assertFalse(verifier.verifyProof(p.a, p.b, p.c, p.pub));
    }

    function test_realProof_fullLifecycle() public {
        _seal();
        P memory p = _load("first");
        bytes32 id = _open(p);
        assertEq(id, p.sessionId);
        assertEq(registry.currentRoot(), fx.readUint(".rootAfterConsume"), "new note inserted at the JS-predicted root");

        // fund: buyer signs EIP-3009 with nonce = sessionId, relayer submits, coordinator marks
        address buyer = fx.readAddress(".buyer");
        uint256 validBefore = block.timestamp + 600;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                token.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), buyer, address(escrow), p.amount, 0, validBefore, id
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(fx.readUint(".buyerPk"), digest);
        token.transferWithAuthorization(buyer, address(escrow), p.amount, 0, validBefore, id, abi.encodePacked(r, s, v));
        vm.prank(coordinator);
        escrow.markFunded(id, keccak256("hsp-order"));

        // 2 calls of 1 USDC, close
        SessionEscrow.Voucher memory vch =
            SessionEscrow.Voucher({sessionId: id, cumulativeAmount: 2e6, callCount: 2, deliveryHashChain: keccak256("chain")});
        (v, r, s) = vm.sign(fx.readUint(".sessionKeyPk"), escrow.voucherDigest(vch));
        vm.prank(fx.readAddress(".seller"));
        escrow.close(id, vch, abi.encodePacked(r, s, v));
        assertEq(token.balanceOf(fx.readAddress(".seller")), 2e6);
        assertEq(token.balanceOf(buyer), 100e6 - 2e6);
    }

    function test_realProof_replayRejected() public {
        _seal();
        P memory p = _load("first");
        _open(p);
        vm.expectRevert(SessionEscrow.NullifierSpent.selector);
        _open(p);
    }

    function test_realProof_tamperedAmountRejected() public {
        _seal();
        P memory p = _load("first");
        p.pub[4] = p.pub[4] + 5e6; // seller's "urgent fee"
        vm.expectRevert(SessionEscrow.InvalidProof.selector);
        _open(p);
    }

    function test_realProof_otherSellerRejected() public {
        _seal();
        P memory p = _load("first");
        vm.expectRevert(abi.encodeWithSelector(SessionEscrow.SignalMismatch.selector, 6));
        escrow.open(p.a, p.b, p.c, p.pub, fx.readAddress(".buyer"), makeAddr("rogue"), p.deadline, p.cartHash);
    }

    function test_realProof_cartSwapRejected() public {
        _seal();
        P memory p = _load("first");
        vm.expectRevert(abi.encodeWithSelector(SessionEscrow.SignalMismatch.selector, 8));
        escrow.open(p.a, p.b, p.c, p.pub, fx.readAddress(".buyer"), fx.readAddress(".seller"), p.deadline, keccak256("swapped"));
    }

    function test_realProof_unknownRootRejected() public {
        // never sealed
        P memory p = _load("first");
        vm.expectRevert(SessionEscrow.UnknownRoot.selector);
        _open(p);
    }

    function test_realProof_secondNoteSpendsAfterFirst() public {
        _seal();
        _open(_load("first"));
        bytes32 id2 = _open(_load("second"));
        assertEq(uint8(escrow.getSession(id2).status), uint8(SessionEscrow.Status.Opened));
    }

    function test_realProof_revokedMandateBlocksWholeChain() public {
        _seal();
        _open(_load("first"));
        registry.revoke(fx.readUint(".revocationKey"));
        vm.expectRevert(SessionEscrow.MandateRevoked.selector);
        _open(_load("second"));
    }
}
