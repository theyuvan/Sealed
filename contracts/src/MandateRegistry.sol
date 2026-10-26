// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PoseidonT2} from "./lib/PoseidonT2.sol";
import {PoseidonT3} from "./lib/PoseidonT3.sol";

/// @title MandateRegistry
/// @notice Holds sealed mandate notes in an incremental Poseidon Merkle tree, the set of spent
///         nullifiers and the set of revoked mandates. Note contents never touch the chain:
///         only salted commitments, nullifiers and revocation tags.
contract MandateRegistry {
    uint256 public constant SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 public constant DEPTH = 20;
    uint256 public constant ROOT_HISTORY = 64;

    address public immutable deployer;
    address public escrow;

    uint256 public nextIndex;
    uint256[DEPTH] public zeros;
    uint256[DEPTH] public filledSubtrees;
    uint256[ROOT_HISTORY] public roots;
    uint256 public currentRootIndex;

    mapping(uint256 => bool) public nullifierSpent;
    mapping(uint256 => bool) public revokedTag;

    event Sealed(uint256 indexed commitment, uint256 leafIndex, bytes auditorCiphertext);
    event Consumed(uint256 indexed nullifier, uint256 newCommitment, uint256 leafIndex);
    event Revoked(uint256 indexed revocationTag);
    event EscrowSet(address escrow);

    error NotEscrow();
    error NotDeployer();
    error EscrowAlreadySet();
    error InvalidCommitment();
    error NullifierAlreadySpent();
    error TreeFull();
    error InvalidKey();

    modifier onlyEscrow() {
        if (msg.sender != escrow) revert NotEscrow();
        _;
    }

    constructor() {
        deployer = msg.sender;
        uint256 z = 0;
        for (uint256 i = 0; i < DEPTH; i++) {
            zeros[i] = z;
            filledSubtrees[i] = z;
            z = PoseidonT3.hash([z, z]);
        }
        roots[0] = z;
    }

    /// @notice One-time wiring; registry and escrow reference each other.
    function setEscrow(address escrow_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (escrow != address(0)) revert EscrowAlreadySet();
        escrow = escrow_;
        emit EscrowSet(escrow_);
    }

    /// @notice Seal a new mandate note. `auditorCiphertext` is the rules encrypted to the auditor key.
    function seal(uint256 commitment, bytes calldata auditorCiphertext) external returns (uint256 leafIndex) {
        if (commitment == 0 || commitment >= SNARK_FIELD) revert InvalidCommitment();
        leafIndex = _insert(commitment);
        emit Sealed(commitment, leafIndex, auditorCiphertext);
    }

    /// @notice Revoke every note of a mandate by revealing its revocation key.
    ///         tag = Poseidon(key); only the owner knows a key whose tag appears in spend proofs.
    function revoke(uint256 revocationKey) external {
        if (revocationKey == 0 || revocationKey >= SNARK_FIELD) revert InvalidKey();
        uint256 tag = PoseidonT2.hash([revocationKey]);
        revokedTag[tag] = true;
        emit Revoked(tag);
    }

    /// @notice Burn a note and insert its successor. Called by SessionEscrow after proof verification.
    function consume(uint256 nullifier, uint256 newCommitment) external onlyEscrow returns (uint256 leafIndex) {
        if (nullifierSpent[nullifier]) revert NullifierAlreadySpent();
        if (newCommitment == 0 || newCommitment >= SNARK_FIELD) revert InvalidCommitment();
        nullifierSpent[nullifier] = true;
        leafIndex = _insert(newCommitment);
        emit Consumed(nullifier, newCommitment, leafIndex);
    }

    function isSpent(uint256 nullifier) external view returns (bool) {
        return nullifierSpent[nullifier];
    }

    function isRevoked(uint256 tag) external view returns (bool) {
        return revokedTag[tag];
    }

    function currentRoot() public view returns (uint256) {
        return roots[currentRootIndex];
    }

    /// @notice True if `root` is one of the last ROOT_HISTORY roots.
    function isKnownRoot(uint256 root) public view returns (bool) {
        if (root == 0) return false;
        uint256 i = currentRootIndex;
        for (uint256 n = 0; n < ROOT_HISTORY; n++) {
            if (roots[i] == root) return true;
            i = i == 0 ? ROOT_HISTORY - 1 : i - 1;
        }
        return false;
    }

    function _insert(uint256 leaf) internal returns (uint256 index) {
        index = nextIndex;
        if (index >= 2 ** DEPTH) revert TreeFull();
        uint256 cur = leaf;
        uint256 idx = index;
        for (uint256 i = 0; i < DEPTH; i++) {
            if (idx & 1 == 0) {
                filledSubtrees[i] = cur;
                cur = PoseidonT3.hash([cur, zeros[i]]);
            } else {
                cur = PoseidonT3.hash([filledSubtrees[i], cur]);
            }
            idx >>= 1;
        }
        uint256 next = (currentRootIndex + 1) % ROOT_HISTORY;
        currentRootIndex = next;
        roots[next] = cur;
        nextIndex = index + 1;
    }
}
