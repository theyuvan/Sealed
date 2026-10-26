pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";

// Recomputes a Poseidon Merkle root from a leaf and its path.
// indices[i] = 1 when the current node is the right child at level i.
template MerkleRoot(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    signal cur[depth + 1];
    signal left[depth];
    signal right[depth];
    component h[depth];

    cur[0] <== leaf;
    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;
        left[i] <== cur[i] + pathIndices[i] * (pathElements[i] - cur[i]);
        right[i] <== pathElements[i] + pathIndices[i] * (cur[i] - pathElements[i]);
        h[i] = Poseidon(2);
        h[i].inputs[0] <== left[i];
        h[i].inputs[1] <== right[i];
        cur[i + 1] <== h[i].out;
    }
    root <== cur[depth];
}
