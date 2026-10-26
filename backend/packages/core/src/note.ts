import { type Address, type Hex, encodeAbiParameters, keccak256 } from "viem";
import { randomField, toField } from "./field.ts";
import { ALLOWLIST_DEPTH, MerkleTree } from "./merkle.ts";
import { poseidon } from "./poseidon.ts";

/** The user's sealed spending rules. Amounts are token base units (USDC: 6 decimals). */
export interface MandateRules {
  maxRemaining: bigint;
  perDealCap: bigint;
  /** category ids (see CATEGORIES), non-zero, at most 16 */
  categories: number[];
  /** allowed seller addresses, at most 16 */
  sellers: Address[];
  /** the pinned stablecoin contract */
  token: Address;
  /** unix seconds */
  expiry: bigint;
}

export interface NoteSecrets {
  mandateId: bigint;
  salt: bigint;
  ownerSecret: bigint;
}

export interface Note {
  rules: MandateRules;
  secrets: NoteSecrets;
}

/** Category ids used inside the circuit. Ids must be non-zero (0 is the empty leaf). */
export const CATEGORIES = {
  "data.nav": 1,
  "data.holders": 2,
  "data.transfers": 3,
  "data.analytics": 4,
  "compute.inference": 5,
} as const;
export type CategoryName = keyof typeof CATEGORIES;

export function categoryTree(categories: number[]): MerkleTree {
  if (categories.length > 2 ** ALLOWLIST_DEPTH) throw new Error("too many categories");
  if (categories.some((c) => c <= 0)) throw new Error("category ids must be positive");
  return new MerkleTree(ALLOWLIST_DEPTH, categories.map(BigInt));
}

export function sellerTree(sellers: Address[]): MerkleTree {
  if (sellers.length > 2 ** ALLOWLIST_DEPTH) throw new Error("too many sellers");
  return new MerkleTree(ALLOWLIST_DEPTH, sellers.map((s) => BigInt(s)));
}

export function newSecrets(mandateId = randomField()): NoteSecrets {
  return { mandateId, salt: randomField(), ownerSecret: randomField() };
}

export function ownerPubKey(ownerSecret: bigint): bigint {
  return poseidon([ownerSecret]);
}

export function commitmentOf(note: Note): bigint {
  const { rules: r, secrets: s } = note;
  return poseidon([
    r.maxRemaining,
    r.perDealCap,
    categoryTree(r.categories).root,
    sellerTree(r.sellers).root,
    BigInt(r.token),
    r.expiry,
    s.mandateId,
    s.salt,
    ownerPubKey(s.ownerSecret),
  ]);
}

export function nullifierOf(note: Note): bigint {
  return poseidon([commitmentOf(note), note.secrets.ownerSecret]);
}

/**
 * Revocation key: secret until the owner revokes. Same for every note of a mandate.
 * The circuit publishes only revTag = H(revKey); revoking reveals revKey, and the registry
 * recomputes the tag on-chain, so nobody but the owner can revoke.
 */
export function revocationKeyOf(secrets: NoteSecrets): bigint {
  return poseidon([secrets.mandateId, secrets.ownerSecret]);
}

export function revocationTagOf(secrets: NoteSecrets): bigint {
  return poseidon([revocationKeyOf(secrets)]);
}

/** The note left after spending `amount`: same rules and owner, less budget, fresh salt. */
export function nextNote(note: Note, amount: bigint, newSalt = randomField()): Note {
  if (amount > note.rules.maxRemaining) throw new Error("amount exceeds remaining budget");
  return {
    rules: { ...note.rules, maxRemaining: note.rules.maxRemaining - amount },
    secrets: { ...note.secrets, salt: newSalt },
  };
}

/** Matches SessionEscrow.computeSessionId. */
export function computeSessionId(o: {
  chainId: number;
  escrow: Address;
  nullifier: bigint;
  buyer: Address;
  seller: Address;
  deadline: bigint;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint64" }],
      [BigInt(o.chainId), o.escrow, o.nullifier, o.buyer, o.seller, o.deadline],
    ),
  );
}

export { toField };
