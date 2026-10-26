import { type Address, type Hex, encodeAbiParameters, keccak256, recoverMessageAddress, isAddressEqual } from "viem";
import type { LocalAccount } from "viem/accounts";

/**
 * A seller's binding quote. The seller commits to (quote, nonce) and signs the commitment, so
 * the Vault only ever evaluates quotes the seller is bound to honour.
 */
export interface SignedQuote {
  serviceId: string;
  /** total price for `calls` calls, token base units */
  quote: bigint;
  calls: number;
  sellerNonce: Hex;
  quoteCommitment: Hex;
  sellerSignature: Hex;
  seller: Address;
}

export function quoteCommitment(o: { serviceId: string; quote: bigint; calls: number; sellerNonce: Hex; seller: Address }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "uint32" }, { type: "bytes32" }, { type: "address" }],
      [o.serviceId, o.quote, o.calls, o.sellerNonce, o.seller],
    ),
  );
}

export async function signQuote(account: LocalAccount, o: { serviceId: string; quote: bigint; calls: number; sellerNonce: Hex }): Promise<SignedQuote> {
  const commitment = quoteCommitment({ ...o, seller: account.address });
  const sellerSignature = await account.signMessage({ message: { raw: commitment } });
  return { ...o, seller: account.address, quoteCommitment: commitment, sellerSignature };
}

/** Returns null if valid, otherwise the reason. */
export async function checkQuote(q: SignedQuote, expectedSeller: Address): Promise<string | null> {
  if (!isAddressEqual(q.seller, expectedSeller)) return "seller mismatch";
  if (quoteCommitment(q) !== q.quoteCommitment) return "commitment does not open to this quote";
  let signer: Address;
  try {
    signer = await recoverMessageAddress({ message: { raw: q.quoteCommitment }, signature: q.sellerSignature });
  } catch {
    return "bad signature";
  }
  return isAddressEqual(signer, expectedSeller) ? null : "quote not signed by seller";
}
