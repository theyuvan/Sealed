import { randomInt } from "node:crypto";
import { type Address, type Hex, type LocalAccount, type PublicClient, isAddressEqual } from "viem";
import { eip3009Abi } from "./abi.ts";
import { EIP3009_TYPES } from "./eip712.ts";
import {
  type HspCartMandate,
  type HspConfig,
  type HspPaymentMandate,
  type HspPaymentMandateContents,
  type X402Payload,
  encodeX402,
  unitsToDecimal,
} from "./hsp.ts";
import { userAuthorization } from "./hsp-crypto.ts";

/** HSP payment_request id the coordinator uses for a session; lets the buyer bind a cart to its session. */
export function sessionPaymentRequestId(sessionId: Hex): string {
  return `SEALED-PR-${sessionId.slice(2).toLowerCase()}`;
}

export function sessionCartMandateId(chainId: number, sessionId: Hex, attempt = 0): string {
  return `SEALED-${chainId}-${sessionId.slice(2, 18).toLowerCase()}${attempt > 0 ? `-R${attempt}` : ""}`;
}

export interface CartExpectation {
  chainId: number;
  token: Address;
  escrow: Address;
  amount: bigint;
  decimals: number;
  sessionId: Hex;
  x402Method: string;
}

/**
 * The buyer reads the cart back from HSP and checks it pays exactly the session: right chain,
 * pinned token, escrow as payee, total = session cap, one line item, bound to this session.
 * Returns null if it matches, otherwise why not (the buyer then refuses to pay).
 */
export function checkCartForSession(cart: HspCartMandate, e: CartExpectation): string | null {
  const c = cart.contents;
  const methods = c.payment_request?.method_data ?? [];
  if (methods.length !== 1) return "cart must offer exactly one payment method";
  const m = methods[0]!;
  if (m.supported_methods !== e.x402Method) return "unexpected payment method";
  if (m.data.chain_id !== e.chainId) return "wrong chain";
  if (!isAddressEqual(m.data.contract_address, e.token)) return "wrong token";
  if (!isAddressEqual(m.data.pay_to, e.escrow)) return "payee is not the session escrow";
  const want = unitsToDecimal(e.amount, e.decimals);
  const d = c.payment_request.details;
  if (d.total.amount.value !== want) return `total ${d.total.amount.value} != session cap ${want}`;
  if (d.display_items.length !== 1 || d.display_items[0]!.amount.value !== want) return "cart has extra or mismatched line items";
  if (d.id !== sessionPaymentRequestId(e.sessionId)) return "cart is not bound to this session";
  if (new Date(c.cart_expiry).getTime() < Date.now()) return "cart expired";
  return null;
}

/** EIP-712 domain of the pinned token (EIP-5267 if available, else name()/version()). */
export async function readTokenDomain(client: PublicClient, token: Address): Promise<{ name: string; version: string }> {
  try {
    const d = await client.readContract({
      address: token,
      abi: [{ type: "function", name: "eip712Domain", stateMutability: "view", inputs: [], outputs: [{ type: "bytes1" }, { type: "string" }, { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256[]" }] }],
      functionName: "eip712Domain",
    });
    return { name: d[1], version: d[2] };
  } catch {
    const [name, version] = await Promise.all([
      client.readContract({ address: token, abi: eip3009Abi, functionName: "name" }),
      client.readContract({ address: token, abi: eip3009Abi, functionName: "version" }),
    ]);
    return { name, version };
  }
}

/** YYYYMMDDHHmmss (UTC) + 6 random digits. TODO(HSP-DOCS): confirm payment_details_id format. */
export function paymentDetailsId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}${String(randomInt(1_000_000)).padStart(6, "0")}`;
}

/**
 * Builds the AP2 payment mandate for a checked cart: an EIP-3009 transferWithAuthorization to the
 * escrow with nonce = sessionId, wrapped as an x402 v2 payload. TODO(HSP-DOCS): payload layout.
 */
export async function buildPaymentMandate(o: {
  cfg: Pick<HspConfig, "x402Method" | "jwtAudience">;
  cart: HspCartMandate;
  payer: LocalAccount;
  chainId: number;
  tokenDomain: { name: string; version: string };
  sessionId: Hex;
  amount: bigint;
  validBefore: bigint;
}): Promise<HspPaymentMandate> {
  const m = o.cart.contents.payment_request.method_data[0]!.data;
  const authorization = { from: o.payer.address, to: m.pay_to, value: o.amount, validAfter: 0n, validBefore: o.validBefore, nonce: o.sessionId };
  const signature = await o.payer.signTypedData({
    domain: { name: o.tokenDomain.name, version: o.tokenDomain.version, chainId: o.chainId, verifyingContract: m.contract_address },
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });
  const x402: X402Payload = {
    x402Version: 2,
    payload: {
      signature,
      authorization: { from: authorization.from, to: authorization.to, value: o.amount.toString(), validAfter: "0", validBefore: o.validBefore.toString(), nonce: o.sessionId },
    },
    accepted: {
      scheme: "exact",
      network: `eip155:${o.chainId}`,
      asset: m.contract_address,
      amount: o.amount.toString(),
      payTo: m.pay_to,
      maxTimeoutSeconds: 300,
      extra: { protocol: "eip3009", name: o.tokenDomain.name, version: o.tokenDomain.version },
    },
  };
  const d = o.cart.contents.payment_request.details;
  const contents: HspPaymentMandateContents = {
    payment_mandate_id: d.id,
    payment_details_id: paymentDetailsId(),
    payment_details_total: { label: d.total.label, amount: d.total.amount, pending: false },
    payment_response: { request_id: d.id, method_name: o.cfg.x402Method, details: { payment_payload: encodeX402(x402) } },
    merchant_agent: o.cart.contents.merchant_name,
    timestamp: new Date().toISOString(),
  };
  return {
    payment_mandate_contents: contents,
    user_authorization: userAuthorization({ payer: o.payer.address, audience: o.cfg.jwtAudience, cartContents: o.cart.contents, paymentContents: contents, expiresAt: Number(o.validBefore) }),
  };
}
