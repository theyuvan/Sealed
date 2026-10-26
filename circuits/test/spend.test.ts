import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Address } from "viem";
import { commitmentOf, MANDATE_TREE_DEPTH, MerkleTree, newSecrets, nullifierOf, poseidon, revocationKeyOf, type Note } from "@sealed/core";
import { buildSpendWitness, proveSpend, shutdownProver, verifySpend, type SpendRequest } from "@sealed/prover";

const TOKEN = "0x00000000000000000000000000000000000000aa" as Address;
const OTHER_TOKEN = "0x00000000000000000000000000000000000000ab" as Address;
const SELLER = "0x00000000000000000000000000000000000000b1" as Address;
const STRANGER = "0x00000000000000000000000000000000000000f0" as Address;
const NOW = 1_800_000_000n;

function freshNote(over: Partial<Note["rules"]> = {}): Note {
  return {
    rules: { maxRemaining: 50_000_000n, perDealCap: 20_000_000n, categories: [1, 2, 3], sellers: [SELLER], token: TOKEN, expiry: NOW + 86_400n, ...over },
    secrets: newSecrets(),
  };
}

function request(note: Note, tree: MerkleTree, over: Partial<SpendRequest> = {}): SpendRequest {
  return { note, tree, amount: 10_000_000n, category: 1, seller: SELLER, cartHash: 111n, sessionId: 222n, sessionKeyHash: 333n, now: NOW, ...over };
}

const CONSTRAINT_FAILURE = /Assert Failed/;

/** true if a valid proof is produced; false only if the circuit itself rejects the witness. */
async function proves(r: SpendRequest): Promise<boolean> {
  const w = buildSpendWitness(r);
  try {
    const { proof, publicSignals } = await proveSpend(w.input);
    return verifySpend(proof, publicSignals);
  } catch (e) {
    if (CONSTRAINT_FAILURE.test(String((e as Error).message))) return false;
    throw e;
  }
}

let note: Note;
let tree: MerkleTree;

beforeAll(() => {
  note = freshNote();
  tree = new MerkleTree(MANDATE_TREE_DEPTH);
  tree.insert(123n); // unrelated leaf so the note is not at index 0
  tree.insert(commitmentOf(note));
});

afterAll(shutdownProver);

describe("spend circuit", () => {
  it("valid spend: proves, verifies, and public signals match the JS model", async () => {
    const w = buildSpendWitness(request(note, tree));
    const { proof, publicSignals } = await proveSpend(w.input);
    expect(await verifySpend(proof, publicSignals)).toBe(true);
    expect(publicSignals.map(BigInt)).toEqual(Object.values(w.publicSignals));
    expect(w.publicSignals.newCommitment).toBe(commitmentOf(w.newNote));
    expect(w.newNote.rules.maxRemaining).toBe(40_000_000n);
  });

  it("amount exactly at the per-deal cap is allowed", async () => {
    expect(await proves(request(note, tree, { amount: 20_000_000n }))).toBe(true);
  });

  it("rejects amount over the per-deal cap", async () => {
    expect(await proves(request(note, tree, { amount: 20_000_001n }))).toBe(false);
  });

  it("rejects amount over the remaining budget", async () => {
    const small = freshNote({ maxRemaining: 5_000_000n });
    const t = new MerkleTree(MANDATE_TREE_DEPTH, [commitmentOf(small)]);
    expect(await proves(request(small, t, { amount: 5_000_001n }))).toBe(false);
    expect(await proves(request(small, t, { amount: 5_000_000n }))).toBe(true);
  });

  it("rejects a seller not in the allowed set", async () => {
    expect(await proves(request(note, tree, { seller: STRANGER }))).toBe(false);
  });

  it("rejects a category not in the allowed set, and category 0", async () => {
    expect(await proves(request(note, tree, { category: 4 }))).toBe(false);
    expect(await proves(request(note, tree, { category: 0 }))).toBe(false);
  });

  it("rejects a different token than the one sealed", async () => {
    const w = buildSpendWitness(request(note, tree));
    w.input.token = BigInt(OTHER_TOKEN).toString();
    await expect(proveSpend(w.input)).rejects.toThrow(CONSTRAINT_FAILURE);
  });

  it("rejects an expired mandate (now >= expiry)", async () => {
    expect(await proves(request(note, tree, { now: note.rules.expiry }))).toBe(false);
    expect(await proves(request(note, tree, { now: note.rules.expiry - 1n }))).toBe(true);
  });

  it("reused nullifier: the same note always yields the same nullifier, and a forged one is rejected", async () => {
    // Double spends are stopped on-chain by the nullifier set (see contracts tests);
    // here we check the circuit pins the nullifier so it cannot be changed to dodge that check.
    const a = buildSpendWitness(request(note, tree, { amount: 1n }));
    const b = buildSpendWitness(request(note, tree, { amount: 2n, cartHash: 999n }));
    expect(a.publicSignals.nullifier).toBe(b.publicSignals.nullifier);
    expect(a.publicSignals.nullifier).toBe(nullifierOf(note));
    const forged = buildSpendWitness(request(note, tree));
    forged.input.nullifier = (forged.publicSignals.nullifier + 1n).toString();
    await expect(proveSpend(forged.input)).rejects.toThrow(CONSTRAINT_FAILURE);
  });

  it("revoked mandate: every note of a mandate carries the same tag, and the tag cannot be forged", async () => {
    // Revocation itself is enforced by MandateRegistry/SessionEscrow (contracts tests);
    // the circuit must publish the true tag so a revoked mandate cannot hide.
    const first = buildSpendWitness(request(note, tree));
    const t2 = new MerkleTree(MANDATE_TREE_DEPTH, [commitmentOf(first.newNote)]);
    const second = buildSpendWitness(request(first.newNote, t2));
    expect(second.publicSignals.revTag).toBe(first.publicSignals.revTag);
    expect(first.publicSignals.revTag).toBe(poseidon([revocationKeyOf(note.secrets)]));
    const forged = buildSpendWitness(request(note, tree));
    forged.input.revTag = "42";
    await expect(proveSpend(forged.input)).rejects.toThrow(CONSTRAINT_FAILURE);
  });

  it("rejects a note that is not in the tree (wrong root)", async () => {
    const w = buildSpendWitness(request(note, tree));
    w.input.root = "7";
    await expect(proveSpend(w.input)).rejects.toThrow(CONSTRAINT_FAILURE);
  });

  it("proof is bound to cartHash, sessionId, sessionKeyHash and amount", async () => {
    const w = buildSpendWitness(request(note, tree));
    const { proof, publicSignals } = await proveSpend(w.input);
    for (const idx of [4, 8, 9, 11]) {
      const tampered = publicSignals.slice();
      tampered[idx] = (BigInt(tampered[idx]!) + 1n).toString();
      expect(await verifySpend(proof, tampered)).toBe(false);
    }
  });
});
