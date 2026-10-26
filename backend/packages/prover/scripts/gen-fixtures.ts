// Generates real Groth16 proofs for the Foundry tests (contracts/test/RealProof.t.sol).
// Run (from backend/): npx tsx packages/prover/scripts/gen-fixtures.ts
//
// The Foundry test deploys from FIXTURE_DEPLOYER in a fixed order, so contract addresses
// (which the session id commits to) are known here in advance:
//   nonce 0: DevEIP3009Token, 1: SpendVerifier, 2: MandateRegistry, 3: SessionEscrow
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getContractAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CATEGORIES,
  commitmentOf,
  computeSessionId,
  MANDATE_TREE_DEPTH,
  MerkleTree,
  poseidon,
  REPO_ROOT,
  revocationKeyOf,
  toField,
  zeroHashes,
  type Note,
} from "@sealed/core";
import { buildSpendWitness, proveSpend, shutdownProver, toSolidityProof } from "../src/index.ts";

const DEPLOYER: Address = "0x00000000000000000000000000000000de910000";
const at = (nonce: number) => getContractAddress({ from: DEPLOYER, nonce: BigInt(nonce) });
const token = at(0);
const escrow = at(3);
const CHAIN_ID = 31337;
const NOW = 1_800_000_000n;
const SESSION_KEY_PK: Hex = "0x00000000000000000000000000000000000000000000000000000000a11ce001";
const sessionKey = privateKeyToAccount(SESSION_KEY_PK).address;
const BUYER_PK: Hex = "0x00000000000000000000000000000000000000000000000000000000b0b00001";
const buyer = privateKeyToAccount(BUYER_PK).address;
const seller: Address = "0x0000000000000000000000000000000000005e11";

const note0: Note = {
  rules: {
    maxRemaining: 50_000_000n,
    perDealCap: 20_000_000n,
    categories: [CATEGORIES["data.nav"], CATEGORIES["data.holders"]],
    sellers: [seller],
    token,
    expiry: NOW + 30n * 86_400n,
  },
  secrets: { mandateId: 1001n, salt: 2002n, ownerSecret: 3003n },
};

async function spend(note: Note, tree: MerkleTree, amount: bigint, label: string, deadline: bigint) {
  const cartHash = keccak256(toHex(`cart:${label}`));
  const nullifier = buildSpendWitness({ note, tree, amount, category: CATEGORIES["data.nav"], seller, cartHash: 0n, sessionId: 0n, sessionKeyHash: 0n, now: NOW }).publicSignals.nullifier;
  const sessionId = computeSessionId({ chainId: CHAIN_ID, escrow, nullifier, buyer, seller, deadline });
  const w = buildSpendWitness({
    note,
    tree,
    amount,
    category: CATEGORIES["data.nav"],
    seller,
    cartHash: toField(cartHash),
    sessionId: toField(sessionId),
    sessionKeyHash: BigInt(sessionKey),
    now: NOW,
    newSalt: BigInt(keccak256(toHex(`salt:${label}`))) % 2n ** 200n,
  });
  const { proof, publicSignals } = await proveSpend(w.input);
  const sol = toSolidityProof(proof, publicSignals);
  return {
    out: {
      a: sol.a.map(String),
      b: sol.b.map((r) => r.map(String)),
      c: sol.c.map(String),
      pub: sol.pubSignals.map(String),
      cartHash,
      sessionId,
      deadline: deadline.toString(),
      amount: amount.toString(),
      newCommitment: w.publicSignals.newCommitment.toString(),
    },
    newNote: w.newNote,
  };
}

const tree = new MerkleTree(MANDATE_TREE_DEPTH);
const c0 = commitmentOf(note0);
tree.insert(c0);
const rootAfterSeal = tree.root;
const deadline = NOW + 3_600n;
const first = await spend(note0, tree, 12_000_000n, "first", deadline);
tree.insert(BigInt(first.out.newCommitment));
const rootAfterConsume = tree.root;
const second = await spend(first.newNote, tree, 8_000_000n, "second", deadline);

const fixture = {
  deployer: DEPLOYER,
  token,
  escrow,
  chainId: CHAIN_ID,
  now: NOW.toString(),
  buyer,
  buyerPk: BUYER_PK,
  seller,
  sessionKey,
  sessionKeyPk: SESSION_KEY_PK,
  commitment0: c0.toString(),
  emptyRoot: zeroHashes(MANDATE_TREE_DEPTH)[MANDATE_TREE_DEPTH]!.toString(),
  rootAfterSeal: rootAfterSeal.toString(),
  rootAfterConsume: rootAfterConsume.toString(),
  poseidon12: poseidon([1n, 2n]).toString(),
  poseidon1: poseidon([1n]).toString(),
  revocationKey: revocationKeyOf(note0.secrets).toString(),
  first: first.out,
  second: second.out,
};

const dir = join(REPO_ROOT, "contracts", "test", "fixtures");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "spend.json"), JSON.stringify(fixture, null, 2));
console.log(`wrote ${join(dir, "spend.json")}`);
await shutdownProver();
