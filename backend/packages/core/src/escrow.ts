import { type Address, type Hex } from "viem";

/** What the Vault returns from /proof/spend (all numbers as decimal strings). */
export interface SpendProofResponse {
  sessionId: Hex;
  deadline: string;
  buyer: Address;
  seller: Address;
  cartHash: Hex;
  amount: string;
  calls: number;
  proof: { a: string[]; b: string[][]; c: string[]; pubSignals: string[] };
}

/** Arguments for SessionEscrow.open, in ABI order. */
export function openSessionArgs(p: SpendProofResponse) {
  const n = (x: string) => BigInt(x);
  return [
    [n(p.proof.a[0]!), n(p.proof.a[1]!)],
    [
      [n(p.proof.b[0]![0]!), n(p.proof.b[0]![1]!)],
      [n(p.proof.b[1]![0]!), n(p.proof.b[1]![1]!)],
    ],
    [n(p.proof.c[0]!), n(p.proof.c[1]!)],
    p.proof.pubSignals.map(n) as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint],
    p.buyer,
    p.seller,
    n(p.deadline),
    p.cartHash,
  ] as const;
}

export const SESSION_STATUS = ["None", "Opened", "Funded", "Closed", "Refunded"] as const;
