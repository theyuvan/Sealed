import { type Address, type Hex, isAddressEqual, keccak256, stringToHex } from "viem";
import { canonicalJson } from "./hsp.ts";

/**
 * The deal the spend proof is bound to (cartHash = keccak256(canonical JSON)). Built from the
 * accepted, seller-signed quote; the Vault recomputes the hash itself, so a seller cannot slip in
 * extra line items after acceptance.
 */
export interface DealCart {
  v: 1;
  chainId: number;
  escrow: Address;
  token: Address;
  seller: Address;
  serviceId: string;
  category: number;
  calls: number;
  /** total price, token base units, decimal string */
  amount: string;
  quoteCommitment: Hex;
}

export function dealCartHash(cart: DealCart): Hex {
  return keccak256(stringToHex(canonicalJson({ ...cart, escrow: cart.escrow.toLowerCase(), token: cart.token.toLowerCase(), seller: cart.seller.toLowerCase() })));
}

export function sameDeal(a: DealCart, b: DealCart): boolean {
  return (
    a.v === b.v &&
    a.chainId === b.chainId &&
    isAddressEqual(a.escrow, b.escrow) &&
    isAddressEqual(a.token, b.token) &&
    isAddressEqual(a.seller, b.seller) &&
    a.serviceId === b.serviceId &&
    a.category === b.category &&
    a.calls === b.calls &&
    a.amount === b.amount &&
    a.quoteCommitment === b.quoteCommitment
  );
}
