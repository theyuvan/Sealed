import { randomBytes } from "node:crypto";
import { type Hex, toHex } from "viem";

/** BN254 scalar field modulus (the field Circom/Groth16 work in). */
export const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Map any 256-bit value (e.g. a keccak hash) into the field. Must match `% SNARK_FIELD` on-chain. */
export function toField(x: Hex | bigint): bigint {
  const v = typeof x === "bigint" ? x : BigInt(x);
  return v % SNARK_FIELD;
}

/** Uniformly random field element (rejection sampling over 254 bits). */
export function randomField(): bigint {
  for (;;) {
    const b = randomBytes(32);
    b[0]! &= 0x3f;
    const v = BigInt(toHex(b));
    if (v !== 0n && v < SNARK_FIELD) return v;
  }
}

export function fieldHex(x: bigint): Hex {
  return toHex(x, { size: 32 });
}
