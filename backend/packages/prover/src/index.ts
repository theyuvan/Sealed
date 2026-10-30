import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";
import { type Address } from "viem";
import {
  ALLOWLIST_DEPTH,
  categoryTree,
  commitmentOf,
  MANDATE_TREE_DEPTH,
  type MerkleTree,
  nextNote,
  type Note,
  nullifierOf,
  randomField,
  revocationTagOf,
  sellerTree,
} from "@sealed/core";

// Circuit artifacts live in the repository-level circuits/ folder (built by circuits/scripts/setup.mjs).
const BUILD = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "circuits", "build");
export const WASM_PATH = join(BUILD, "spend_js", "spend.wasm");
export const ZKEY_PATH = join(BUILD, "spend_final.zkey");
export const VKEY_PATH = join(BUILD, "verification_key.json");

/** Public signal order, as declared in spend.circom and expected by SpendVerifier / SessionEscrow. */
export const PUBLIC_SIGNALS = [
  "root",
  "nullifier",
  "newCommitment",
  "revTag",
  "amount",
  "category",
  "seller",
  "token",
  "cartHash",
  "sessionId",
  "now",
  "sessionKeyHash",
] as const;
export type PublicSignalName = (typeof PUBLIC_SIGNALS)[number];

export interface SpendRequest {
  note: Note;
  /** mirror of the registry tree that contains the note's commitment */
  tree: MerkleTree;
  amount: bigint;
  category: number;
  seller: Address;
  /** field elements (already reduced mod p) */
  cartHash: bigint;
  sessionId: bigint;
  sessionKeyHash: bigint;
  now: bigint;
  newSalt?: bigint;
}

export interface SpendWitness {
  input: Record<string, string | string[]>;
  publicSignals: Record<PublicSignalName, bigint>;
  newNote: Note;
}

const str = (x: bigint | number) => x.toString();

/**
 * Builds the circuit input. Does not check the rules itself: an invalid request produces a
 * witness the circuit rejects, which is what the circuit tests rely on.
 */
export function buildSpendWitness(r: SpendRequest): SpendWitness {
  const { note } = r;
  const commitment = commitmentOf(note);
  const leafIndex = r.tree.indexOf(commitment);
  if (leafIndex < 0) throw new Error("note commitment is not in the tree");
  if (r.tree.depth !== MANDATE_TREE_DEPTH) throw new Error("wrong tree depth");
  const mp = r.tree.proof(leafIndex);

  const cats = categoryTree(note.rules.categories);
  const sels = sellerTree(note.rules.sellers);
  // For a value outside the list we still need a well-formed path; use slot 0 so the circuit fails on the root.
  const ci = Math.max(0, cats.indexOf(BigInt(r.category)));
  const si = Math.max(0, sels.indexOf(BigInt(r.seller)));
  const cp = cats.leaves.length ? cats.proof(ci) : { pathElements: Array(ALLOWLIST_DEPTH).fill(0n), pathIndices: Array(ALLOWLIST_DEPTH).fill(0) };
  const sp = sels.leaves.length ? sels.proof(si) : { pathElements: Array(ALLOWLIST_DEPTH).fill(0n), pathIndices: Array(ALLOWLIST_DEPTH).fill(0) };

  const newSalt = r.newSalt ?? randomField();
  // nextNote throws on overspend; keep the witness buildable so the circuit is what rejects it
  const newNote =
    r.amount <= note.rules.maxRemaining
      ? nextNote(note, r.amount, newSalt)
      : { rules: { ...note.rules, maxRemaining: 0n }, secrets: { ...note.secrets, salt: newSalt } };

  const publicSignals: Record<PublicSignalName, bigint> = {
    root: mp.root,
    nullifier: nullifierOf(note),
    newCommitment: commitmentOf(newNote),
    revTag: revocationTagOf(note.secrets),
    amount: r.amount,
    category: BigInt(r.category),
    seller: BigInt(r.seller),
    token: BigInt(note.rules.token),
    cartHash: r.cartHash,
    sessionId: r.sessionId,
    now: r.now,
    sessionKeyHash: r.sessionKeyHash,
  };

  const input: Record<string, string | string[]> = {};
  for (const k of PUBLIC_SIGNALS) input[k] = str(publicSignals[k]);
  Object.assign(input, {
    maxRemaining: str(note.rules.maxRemaining),
    perDealCap: str(note.rules.perDealCap),
    categoriesRoot: str(cats.root),
    sellersRoot: str(sels.root),
    expiry: str(note.rules.expiry),
    mandateId: str(note.secrets.mandateId),
    salt: str(note.secrets.salt),
    ownerSecret: str(note.secrets.ownerSecret),
    newSalt: str(newSalt),
    merklePath: mp.pathElements.map(str),
    merkleIndices: mp.pathIndices.map(str),
    categoryPath: cp.pathElements.map(str),
    categoryIndices: cp.pathIndices.map(str),
    sellerPath: sp.pathElements.map(str),
    sellerIndices: sp.pathIndices.map(str),
  });
  return { input, publicSignals, newNote };
}

export interface Groth16Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}

export interface SolidityProof {
  a: [bigint, bigint];
  b: [[bigint, bigint], [bigint, bigint]];
  c: [bigint, bigint];
  pubSignals: bigint[];
}

export function assertArtifacts(): void {
  for (const f of [WASM_PATH, ZKEY_PATH, VKEY_PATH]) {
    if (!existsSync(f)) throw new Error(`missing circuit artifact ${f}; run npm run circuits:setup`);
  }
}

/** Generates a Groth16 proof. Throws if the witness violates the circuit. */
export async function proveSpend(input: SpendWitness["input"]): Promise<{ proof: Groth16Proof; publicSignals: string[] }> {
  assertArtifacts();
  return snarkjs.groth16.fullProve(input, WASM_PATH, ZKEY_PATH);
}

let vkey: unknown;
export async function verifySpend(proof: Groth16Proof, publicSignals: string[]): Promise<boolean> {
  vkey ??= JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(VKEY_PATH, "utf8")));
  return snarkjs.groth16.verify(vkey, publicSignals, proof);
}

/** Converts a snarkjs proof to the argument layout of SpendVerifier.verifyProof (note the b swap). */
export function toSolidityProof(proof: Groth16Proof, publicSignals: string[]): SolidityProof {
  const p = (x: string) => BigInt(x);
  return {
    a: [p(proof.pi_a[0]!), p(proof.pi_a[1]!)],
    b: [
      [p(proof.pi_b[0]![1]!), p(proof.pi_b[0]![0]!)],
      [p(proof.pi_b[1]![1]!), p(proof.pi_b[1]![0]!)],
    ],
    c: [p(proof.pi_c[0]!), p(proof.pi_c[1]!)],
    pubSignals: publicSignals.map(p),
  };
}

/** snarkjs may leave worker threads alive; call when a CLI is done. */
export async function shutdownProver(): Promise<void> {
  const curve = (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128;
  if (curve) await curve.terminate();
}

export interface CircuitInfo {
  protocol: string;
  curve: string;
  /** declared public signals, in order */
  publicSignals: readonly string[];
  nPublic: number;
  /** from the proving key's header: circuit variables and the power-of-two domain that bounds the constraint count */
  variables: number | null;
  domainSize: number | null;
  zkeyBytes: number;
  wasmBytes: number;
  treeDepth: number;
  allowlistDepth: number;
}

/** What the built circuit is: read from the verification key and the zkey header, not hard-coded. */
export async function circuitInfo(): Promise<CircuitInfo> {
  assertArtifacts();
  const fs = await import("node:fs/promises");
  const vk = JSON.parse(await fs.readFile(VKEY_PATH, "utf8")) as { protocol: string; curve: string; nPublic: number };
  // zkey: "zkey", u32 version, u32 nSections, then (u32 type, u64 size, payload)*; section 2 is the Groth16 header
  let variables: number | null = null;
  let domainSize: number | null = null;
  const fh = await fs.open(ZKEY_PATH, "r");
  try {
    const head = Buffer.alloc(12);
    await fh.read(head, 0, 12, 0);
    if (head.toString("latin1", 0, 4) === "zkey") {
      const n = head.readUInt32LE(8);
      let pos = 12;
      for (let i = 0; i < n; i++) {
        const sh = Buffer.alloc(12);
        await fh.read(sh, 0, 12, pos);
        const type = sh.readUInt32LE(0);
        const size = Number(sh.readBigUInt64LE(4));
        if (type === 2) {
          const b = Buffer.alloc(Math.min(size, 256));
          await fh.read(b, 0, b.length, pos + 12);
          const n8q = b.readUInt32LE(0);
          const n8r = b.readUInt32LE(4 + n8q);
          const o = 4 + n8q + 4 + n8r;
          variables = b.readUInt32LE(o);
          domainSize = b.readUInt32LE(o + 8);
          break;
        }
        pos += 12 + size;
      }
    }
  } finally {
    await fh.close();
  }
  const [z, w] = await Promise.all([fs.stat(ZKEY_PATH), fs.stat(WASM_PATH)]);
  return { protocol: vk.protocol, curve: vk.curve, publicSignals: PUBLIC_SIGNALS, nPublic: vk.nPublic, variables, domainSize, zkeyBytes: z.size, wasmBytes: w.size, treeDepth: MANDATE_TREE_DEPTH, allowlistDepth: ALLOWLIST_DEPTH };
}
