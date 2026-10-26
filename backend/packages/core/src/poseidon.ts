import * as P from "poseidon-lite";

// poseidon-lite uses the same constants as circomlib's Poseidon, so these hashes match the circuit
// and the on-chain PoseidonT2/PoseidonT3 libraries.
const BY_ARITY: Record<number, (inputs: bigint[]) => bigint> = {
  1: P.poseidon1,
  2: P.poseidon2,
  3: P.poseidon3,
  4: P.poseidon4,
  5: P.poseidon5,
  6: P.poseidon6,
  7: P.poseidon7,
  8: P.poseidon8,
  9: P.poseidon9,
  10: P.poseidon10,
  11: P.poseidon11,
  12: P.poseidon12,
  13: P.poseidon13,
  14: P.poseidon14,
  15: P.poseidon15,
  16: P.poseidon16,
};

export function poseidon(inputs: bigint[]): bigint {
  const fn = BY_ARITY[inputs.length];
  if (!fn) throw new Error(`poseidon: unsupported arity ${inputs.length}`);
  return fn(inputs);
}
