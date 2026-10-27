import { type Address, type Hex, sha256, stringToHex } from "viem";

/*
 * HSP (HashKey Settlement Protocol) wire format: AP2 cart mandate (merchant) -> AP2 payment
 * mandate carrying an x402 EIP-3009 authorization (payer) -> HSP relays the transfer and reports
 * status by signed webhook.
 *
 * TODO(HSP-DOCS): every field name and constant in this file was taken from public HSK
 * integrations, not from the official HSP manual. Confirm each against the manual on
 * hashfans.io / the project-hsp SDK. All of them can be overridden through HspConfig.
 */

export interface HspConfig {
  /** Merchant API base URL, e.g. the QA host from the README. No default on purpose. */
  baseUrl: string;
  /** Payer/checkout API base URL. TODO(HSP-DOCS): may differ from the merchant base. */
  payerBaseUrl: string;
  appKey: string;
  appSecret: string;
  /** ES256K private key (0x hex or PEM). Public key must be registered with HashKey. */
  merchantPrivateKey: string;
  merchantName: string;
  webhookSecret: string;
  paths: {
    createOrder: string; // TODO(HSP-DOCS)
    payments: string; // TODO(HSP-DOCS)
    cartByFlow: string; // TODO(HSP-DOCS) contains {flowId}
    payMandate: string; // TODO(HSP-DOCS)
  };
  headers: {
    appKey: string; // TODO(HSP-DOCS)
    timestamp: string; // TODO(HSP-DOCS)
    nonce: string; // TODO(HSP-DOCS)
    signature: string; // TODO(HSP-DOCS)
    webhookSignature: string; // TODO(HSP-DOCS)
  };
  /** JWT `aud` for merchant_authorization and user_authorization. TODO(HSP-DOCS) */
  jwtAudience: string;
  /** `supported_methods` value for x402 in the cart's method_data. TODO(HSP-DOCS) */
  x402Method: string;
  /** network name HSP uses in method_data for this chain. TODO(HSP-DOCS) */
  networkName: string;
  /** coin symbol HSP uses for the pinned token. TODO(HSP-DOCS) */
  coin: string;
  /** webhook body field that uniquely identifies the event (dedupe key). TODO(HSP-DOCS) */
  webhookEventIdField: string;
  /** statuses that mean the transfer is done. TODO(HSP-DOCS) */
  successStatuses: string[];
  failedStatuses: string[];
  /** True when talking to the "HSP local stand-in" instead of HashKey. */
  localStandIn: boolean;
}

export const HSP_DEFAULT_PATHS: HspConfig["paths"] = {
  createOrder: "/api/v1/merchant/orders",
  payments: "/api/v1/merchant/payments",
  cartByFlow: "/api/v1/payment/cart-mandate/flow/{flowId}",
  payMandate: "/api/v1/payment/pay-mandate",
};

export const HSP_DEFAULT_HEADERS: HspConfig["headers"] = {
  appKey: "X-App-Key",
  timestamp: "X-Timestamp",
  nonce: "X-Nonce",
  signature: "X-Signature",
  webhookSignature: "X-Signature",
};

/** Max age of a webhook (README 9.4). */
export const HSP_WEBHOOK_MAX_AGE_SECONDS = 300;

export interface HspAmount {
  currency: string;
  value: string;
}

export interface HspMethodData {
  supported_methods: string;
  data: {
    x402Version: number;
    network: string;
    chain_id: number;
    contract_address: Address;
    pay_to: Address;
    coin: string;
  };
}

/** AP2 cart mandate contents. TODO(HSP-DOCS): field names. */
export interface HspCartContents {
  id: string;
  user_cart_confirmation_required: boolean;
  payment_request: {
    method_data: HspMethodData[];
    details: {
      id: string;
      display_items: { label: string; amount: HspAmount }[];
      total: { label: string; amount: HspAmount };
    };
  };
  cart_expiry: string;
  merchant_name: string;
}

export interface HspCartMandate {
  contents: HspCartContents;
  merchant_authorization: string;
}

/** x402 v2 "exact" payload carrying an EIP-3009 authorization. TODO(HSP-DOCS) */
export interface X402Payload {
  x402Version: number;
  payload: {
    signature: Hex;
    authorization: { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex };
  };
  accepted: {
    scheme: "exact";
    network: string;
    asset: Address;
    amount: string;
    payTo: Address;
    maxTimeoutSeconds: number;
    extra: { protocol: "eip3009"; name: string; version: string };
  };
}

/** AP2 payment mandate. TODO(HSP-DOCS) */
export interface HspPaymentMandateContents {
  payment_mandate_id: string;
  payment_details_id: string;
  payment_details_total: { label: string; amount: HspAmount; pending: boolean };
  payment_response: {
    request_id: string;
    method_name: string;
    details: { payment_payload: string };
  };
  merchant_agent: string;
  timestamp: string;
}

export interface HspPaymentMandate {
  payment_mandate_contents: HspPaymentMandateContents;
  user_authorization: string;
}

/** Payment status record (status endpoint and webhook body). TODO(HSP-DOCS) */
export interface HspPaymentRecord {
  payment_request_id: string;
  cart_mandate_id: string;
  flow_id?: string;
  status: string;
  status_reason?: string | null;
  request_id?: string;
  /** token-denominated decimal strings; pay_amount = order_amount + any fees the payer bears */
  amount?: string;
  order_amount?: string;
  pay_amount?: string;
  token_address?: string;
  chain_id?: number;
  payer_address?: string;
  pay_to?: string;
  tx_signature?: string | null;
  [k: string]: unknown;
}

export interface HspCreateOrderResult {
  payment_url?: string;
  flow_id?: string;
  payment_request_id?: string;
  cart_mandate_id?: string;
}

/** Key-sorted JSON (RFC 8785 style for the values we send: strings, integers, booleans). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(sortKeys);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as object).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
  return out;
}

/** sha256 of canonical JSON, lowercase hex without 0x. TODO(HSP-DOCS): exact cart_hash format. */
export function hspHash(value: unknown): string {
  return sha256(stringToHex(canonicalJson(value))).slice(2);
}

/** Token base units -> decimal string ("12.50"). */
export function unitsToDecimal(units: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = units / base;
  let frac = (units % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${whole}.${frac}`;
}

/** Decimal string -> token base units. Rejects more precision than the token has. */
export function decimalToUnits(value: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`not a decimal amount: ${value}`);
  const frac = m[2] ?? "";
  if (frac.replace(/0+$/, "").length > decimals) throw new Error(`${value} has more than ${decimals} decimals`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function encodeX402(p: X402Payload): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64");
}

export function decodeX402(b64: string): X402Payload {
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as X402Payload;
}

export type HspStatusClass = "success" | "failed" | "pending";

export function hspStatusClass(cfg: Pick<HspConfig, "successStatuses" | "failedStatuses">, status: string | undefined): HspStatusClass {
  const s = (status ?? "").toLowerCase();
  if (cfg.successStatuses.includes(s)) return "success";
  if (cfg.failedStatuses.includes(s)) return "failed";
  return "pending";
}
