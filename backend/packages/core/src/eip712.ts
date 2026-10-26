import { type Address, type Hex, encodeAbiParameters, keccak256, zeroHash } from "viem";

export interface Voucher {
  sessionId: Hex;
  cumulativeAmount: bigint;
  callCount: number;
  deliveryHashChain: Hex;
}

export const VOUCHER_TYPES = {
  Voucher: [
    { name: "sessionId", type: "bytes32" },
    { name: "cumulativeAmount", type: "uint128" },
    { name: "callCount", type: "uint32" },
    { name: "deliveryHashChain", type: "bytes32" },
  ],
} as const;

export function voucherDomain(chainId: number, escrow: Address) {
  return { name: "SealedSessionEscrow", version: "1", chainId, verifyingContract: escrow } as const;
}

/** chain_0 = 0, chain_n = keccak(chain_{n-1} || deliveryHash_n) */
export function nextDeliveryChain(prev: Hex, deliveryHash: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [prev, deliveryHash]));
}

export const EMPTY_DELIVERY_CHAIN: Hex = zeroHash;

export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface Eip3009Authorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}
