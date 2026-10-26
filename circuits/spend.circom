pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "./lib/merkle.circom";

// Spend proof (README section 8): a deal of `amount` to `seller` in `category`, paid in `token`,
// fits a sealed mandate note that is in the registry tree under `root`. Burns the note
// (nullifier) and creates the next note with the remaining budget (newCommitment).
//
// Note:       commitment = Poseidon(maxRemaining, perDealCap, categoriesRoot, sellersRoot,
//                                   token, expiry, mandateId, salt, ownerPubKey)
//             ownerPubKey = Poseidon(ownerSecret)
// Nullifier:  Poseidon(commitment, ownerSecret)
// Revocation: revTag = Poseidon(revKey), revKey = Poseidon(mandateId, ownerSecret)
template Spend(TREE_DEPTH, LIST_DEPTH) {
    // ---- public (order = public signal order)
    signal input root;
    signal input nullifier;
    signal input newCommitment;
    signal input revTag;
    signal input amount;
    signal input category;
    signal input seller;
    signal input token;
    signal input cartHash;
    signal input sessionId;
    signal input now;
    signal input sessionKeyHash;

    // ---- private
    signal input maxRemaining;
    signal input perDealCap;
    signal input categoriesRoot;
    signal input sellersRoot;
    signal input expiry;
    signal input mandateId;
    signal input salt;
    signal input ownerSecret;
    signal input newSalt;
    signal input merklePath[TREE_DEPTH];
    signal input merkleIndices[TREE_DEPTH];
    signal input categoryPath[LIST_DEPTH];
    signal input categoryIndices[LIST_DEPTH];
    signal input sellerPath[LIST_DEPTH];
    signal input sellerIndices[LIST_DEPTH];

    // 1. owner key, commitment, tree membership
    signal ownerPubKey <== Poseidon(1)([ownerSecret]);
    signal commitment <== Poseidon(9)([maxRemaining, perDealCap, categoriesRoot, sellersRoot, token, expiry, mandateId, salt, ownerPubKey]);
    signal computedRoot <== MerkleRoot(TREE_DEPTH)(commitment, merklePath, merkleIndices);
    computedRoot === root;

    // 2. nullifier and revocation tag
    signal computedNullifier <== Poseidon(2)([commitment, ownerSecret]);
    computedNullifier === nullifier;
    signal revKey <== Poseidon(2)([mandateId, ownerSecret]);
    signal computedRevTag <== Poseidon(1)([revKey]);
    computedRevTag === revTag;

    // 3. amount <= perDealCap and amount <= maxRemaining, all values range-checked to 64 bits
    component bits[5];
    bits[0] = Num2Bits(64); bits[0].in <== amount;
    bits[1] = Num2Bits(64); bits[1].in <== perDealCap;
    bits[2] = Num2Bits(64); bits[2].in <== maxRemaining;
    bits[3] = Num2Bits(64); bits[3].in <== now;
    bits[4] = Num2Bits(64); bits[4].in <== expiry;

    signal underCap <== LessEqThan(64)([amount, perDealCap]);
    underCap === 1;
    signal underBudget <== LessEqThan(64)([amount, maxRemaining]);
    underBudget === 1;

    // 4. category and seller are in the allow-lists (non-zero, since 0 is the empty leaf)
    signal categoryIsZero <== IsZero()(category);
    categoryIsZero === 0;
    signal catRoot <== MerkleRoot(LIST_DEPTH)(category, categoryPath, categoryIndices);
    catRoot === categoriesRoot;

    signal sellerIsZero <== IsZero()(seller);
    sellerIsZero === 0;
    signal selRoot <== MerkleRoot(LIST_DEPTH)(seller, sellerPath, sellerIndices);
    selRoot === sellersRoot;

    // 5. token: the public `token` is hashed into the commitment above, so a different token
    //    gives a commitment that is not in the tree.

    // 6. not expired
    signal notExpired <== LessThan(64)([now, expiry]);
    notExpired === 1;

    // 7. next note: same rules, budget reduced by amount, fresh salt
    signal remaining <== maxRemaining - amount;
    signal computedNew <== Poseidon(9)([remaining, perDealCap, categoriesRoot, sellersRoot, token, expiry, mandateId, newSalt, ownerPubKey]);
    computedNew === newCommitment;

    // 8. bind the remaining public signals so they cannot be changed after proving
    signal cartSq <== cartHash * cartHash;
    signal sessionSq <== sessionId * sessionId;
    signal keySq <== sessionKeyHash * sessionKeyHash;
}

component main {public [root, nullifier, newCommitment, revTag, amount, category, seller, token, cartHash, sessionId, now, sessionKeyHash]} = Spend(20, 4);
