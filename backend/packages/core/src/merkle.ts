import { poseidon } from "./poseidon.ts";

export const MANDATE_TREE_DEPTH = 20;
/** Depth of the allow-list trees for categories and sellers (16 entries each). */
export const ALLOWLIST_DEPTH = 4;

export interface MerkleProof {
  pathElements: bigint[];
  /** bit i = 1 when the node at level i is a right child */
  pathIndices: number[];
  root: bigint;
  leaf: bigint;
  index: number;
}

const zeroCache = new Map<number, bigint[]>();

/** zeros[0] = 0, zeros[i+1] = H(zeros[i], zeros[i]). Same as MandateRegistry. */
export function zeroHashes(depth: number): bigint[] {
  let z = zeroCache.get(depth);
  if (!z) {
    z = [0n];
    for (let i = 0; i < depth; i++) z.push(poseidon([z[i]!, z[i]!]));
    zeroCache.set(depth, z);
  }
  return z;
}

/**
 * Append-only Poseidon Merkle tree. Mirrors the on-chain incremental tree in MandateRegistry
 * (leaves are inserted left to right; empty leaves are 0).
 */
export class MerkleTree {
  readonly leaves: bigint[] = [];
  private readonly zeros: bigint[];

  constructor(readonly depth: number, leaves: bigint[] = []) {
    this.zeros = zeroHashes(depth);
    for (const l of leaves) this.insert(l);
  }

  insert(leaf: bigint): number {
    if (this.leaves.length >= 2 ** this.depth) throw new Error("merkle tree full");
    this.leaves.push(leaf);
    return this.leaves.length - 1;
  }

  /** Nodes of `level` (level 0 = leaves), padded only as far as needed. */
  private level(level: number): bigint[] {
    let nodes = this.leaves.slice();
    for (let l = 0; l < level; l++) {
      const next: bigint[] = [];
      for (let i = 0; i < nodes.length; i += 2) {
        next.push(poseidon([nodes[i]!, i + 1 < nodes.length ? nodes[i + 1]! : this.zeros[l]!]));
      }
      nodes = next;
    }
    return nodes;
  }

  get root(): bigint {
    if (this.leaves.length === 0) return this.zeros[this.depth]!;
    return this.level(this.depth)[0]!;
  }

  proof(index: number): MerkleProof {
    if (index < 0 || index >= this.leaves.length) throw new Error(`no leaf at index ${index}`);
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];
    let nodes = this.leaves.slice();
    let idx = index;
    for (let l = 0; l < this.depth; l++) {
      const sibling = idx ^ 1;
      pathElements.push(sibling < nodes.length ? nodes[sibling]! : this.zeros[l]!);
      pathIndices.push(idx & 1);
      const next: bigint[] = [];
      for (let i = 0; i < nodes.length; i += 2) {
        next.push(poseidon([nodes[i]!, i + 1 < nodes.length ? nodes[i + 1]! : this.zeros[l]!]));
      }
      nodes = next;
      idx >>= 1;
    }
    return { pathElements, pathIndices, root: nodes[0]!, leaf: this.leaves[index]!, index };
  }

  indexOf(leaf: bigint): number {
    return this.leaves.indexOf(leaf);
  }
}

export function verifyMerkleProof(p: MerkleProof): boolean {
  let node = p.leaf;
  for (let i = 0; i < p.pathElements.length; i++) {
    node = p.pathIndices[i] ? poseidon([p.pathElements[i]!, node]) : poseidon([node, p.pathElements[i]!]);
  }
  return node === p.root;
}
