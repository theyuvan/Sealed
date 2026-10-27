import type { KeyObject } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  canonicalJson,
  HSP_DEFAULT_HEADERS,
  HSP_DEFAULT_PATHS,
  type HspCartMandate,
  type HspConfig,
  type HspCreateOrderResult,
  type HspPaymentMandate,
  type HspPaymentRecord,
} from "./hsp.ts";
import { merchantKey, signedRequestValues } from "./hsp-crypto.ts";

export class HspApiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * Client for the HashKey Merchant API (HSP). Merchant calls are HMAC-signed; payer calls
 * (cart lookup, pay-mandate) are made by the buyer with no merchant credentials.
 *
 * TODO(HSP-DOCS): response envelope `{ code, msg, data }` with code 0 = success is assumed.
 */
export class HspClient {
  private key?: KeyObject;

  constructor(readonly cfg: HspConfig) {}

  get merchantKey(): KeyObject {
    this.key ??= merchantKey(this.cfg.merchantPrivateKey);
    return this.key;
  }

  private async send<T>(base: string, method: "GET" | "POST", path: string, o: { query?: Record<string, string>; body?: unknown; signed: boolean }): Promise<T> {
    const query = new URLSearchParams(o.query ?? {}).toString();
    const body = o.body === undefined ? "" : canonicalJson(o.body);
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (o.signed) {
      const s = signedRequestValues({ method, path, query, body, secret: this.cfg.appSecret });
      headers[this.cfg.headers.appKey] = this.cfg.appKey;
      headers[this.cfg.headers.timestamp] = s.timestamp;
      headers[this.cfg.headers.nonce] = s.nonce;
      headers[this.cfg.headers.signature] = s.signature;
    }
    let res: Response;
    try {
      res = await fetch(`${base}${path}${query ? `?${query}` : ""}`, { method, headers, body: body || undefined, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new HspApiError(`HSP unreachable: ${(err as Error).message}`, true);
    }
    const text = await res.text();
    let json: { code?: number; msg?: string; message?: string; data?: unknown };
    try {
      json = JSON.parse(text);
    } catch {
      throw new HspApiError(`HSP ${method} ${path}: HTTP ${res.status}, non-JSON body`, res.status >= 500 || res.status === 429, res.status);
    }
    if (!res.ok || (json.code !== undefined && json.code !== 0)) {
      throw new HspApiError(`HSP ${method} ${path}: HTTP ${res.status} code ${json.code}: ${json.msg ?? json.message ?? ""}`, res.status >= 500 || res.status === 429, res.status);
    }
    return json.data as T;
  }

  // ---- merchant side (signed)

  createOrder(cartMandate: HspCartMandate, redirectUrl?: string): Promise<HspCreateOrderResult> {
    return this.send(this.cfg.baseUrl, "POST", this.cfg.paths.createOrder, {
      body: { cart_mandate: cartMandate, ...(redirectUrl ? { redirect_url: redirectUrl } : {}) },
      signed: true,
    });
  }

  async payments(query: { cart_mandate_id: string } | { payment_request_id: string } | { flow_id: string }): Promise<HspPaymentRecord[]> {
    const data = await this.send<HspPaymentRecord[] | HspPaymentRecord | null>(this.cfg.baseUrl, "GET", this.cfg.paths.payments, {
      query: query as Record<string, string>,
      signed: true,
    });
    if (!data) return [];
    return Array.isArray(data) ? data : [data];
  }

  // ---- payer side

  /** TODO(HSP-DOCS): response shape `{ cartmandate }` assumed. */
  async cartByFlow(flowId: string): Promise<HspCartMandate> {
    const data = await this.send<{ cartmandate?: HspCartMandate; cart_mandate?: HspCartMandate }>(
      this.cfg.payerBaseUrl,
      "GET",
      this.cfg.paths.cartByFlow.replace("{flowId}", encodeURIComponent(flowId)),
      { signed: false },
    );
    const cart = data.cartmandate ?? data.cart_mandate;
    if (!cart) throw new HspApiError("HSP cart lookup returned no cart mandate", false);
    return cart;
  }

  payMandate(flowId: string, paymentMandate: HspPaymentMandate): Promise<unknown> {
    return this.send(this.cfg.payerBaseUrl, "POST", this.cfg.paths.payMandate, {
      body: { flow_id: flowId, payment_mandate: paymentMandate },
      signed: false,
    });
  }
}

/**
 * Reads HSP config from env. `HSP_LOCAL_STANDIN=1` switches to the "HSP local stand-in"
 * (development only); it is refused on mainnet.
 */
export function hspConfigFromEnv(rawEnv: NodeJS.ProcessEnv, chainId: number): HspConfig {
  // empty values (e.g. `HSP_PAYER_BASE_URL=` left blank in .env) count as unset
  const env = Object.fromEntries(Object.entries(rawEnv).filter(([, v]) => v !== "")) as NodeJS.ProcessEnv;
  const localStandIn = env.HSP_LOCAL_STANDIN === "1" || env.HSP_LOCAL_STANDIN === "true";
  if (localStandIn && chainId === 177) throw new Error("HSP local stand-in must not be used on mainnet (CHAIN_ID=177)");
  const baseUrl = localStandIn ? (env.HSP_STANDIN_URL ?? "http://127.0.0.1:7301") : need(env, "HSP_BASE_URL");
  const list = (v: string | undefined, d: string[]) => (v ? v.split(",").map((s) => s.trim().toLowerCase()) : d);
  return {
    baseUrl,
    payerBaseUrl: localStandIn ? baseUrl : (env.HSP_PAYER_BASE_URL ?? baseUrl),
    appKey: need(env, "HSP_APP_KEY"),
    appSecret: need(env, "HSP_APP_SECRET"),
    merchantPrivateKey: keyOrFile(env.HSP_MERCHANT_PRIVATE_KEY),
    merchantName: env.HSP_MERCHANT_NAME ?? "Sealed",
    webhookSecret: env.HSP_WEBHOOK_SECRET ?? env.HSP_APP_SECRET ?? "",
    paths: {
      createOrder: env.HSP_PATH_CREATE_ORDER ?? HSP_DEFAULT_PATHS.createOrder,
      payments: env.HSP_PATH_PAYMENTS ?? HSP_DEFAULT_PATHS.payments,
      cartByFlow: env.HSP_PATH_CART_BY_FLOW ?? HSP_DEFAULT_PATHS.cartByFlow,
      payMandate: env.HSP_PATH_PAY_MANDATE ?? HSP_DEFAULT_PATHS.payMandate,
    },
    headers: {
      appKey: env.HSP_HEADER_APP_KEY ?? HSP_DEFAULT_HEADERS.appKey,
      timestamp: env.HSP_HEADER_TIMESTAMP ?? HSP_DEFAULT_HEADERS.timestamp,
      nonce: env.HSP_HEADER_NONCE ?? HSP_DEFAULT_HEADERS.nonce,
      signature: env.HSP_HEADER_SIGNATURE ?? HSP_DEFAULT_HEADERS.signature,
      webhookSignature: env.HSP_HEADER_WEBHOOK_SIGNATURE ?? HSP_DEFAULT_HEADERS.webhookSignature,
    },
    jwtAudience: env.HSP_JWT_AUDIENCE ?? "HashkeyMerchant",
    x402Method: env.HSP_X402_METHOD ?? "https://www.x402.org/",
    networkName: env.HSP_NETWORK_NAME ?? (chainId === 177 ? "hashkey" : chainId === 133 ? "hashkey-testnet" : "local"),
    coin: env.HSP_COIN ?? "USDC",
    webhookEventIdField: env.HSP_WEBHOOK_EVENT_ID_FIELD ?? "request_id",
    // HSP webhooks fire on payment-included, -safe, -finalized and -failed; the coordinator re-checks the chain itself
    successStatuses: list(env.HSP_SUCCESS_STATUSES, ["payment-included", "payment-safe", "payment-finalized"]),
    failedStatuses: list(env.HSP_FAILED_STATUSES, ["payment-failed"]),
    localStandIn,
  };
}

/** HSP_MERCHANT_PRIVATE_KEY may be PEM text, 0x-hex, or a path to a PEM file. */
function keyOrFile(v: string | undefined): string {
  if (!v) return "";
  if (v.includes("BEGIN") || /^(0x)?[0-9a-fA-F]{64}$/.test(v.trim())) return v;
  return existsSync(v) ? readFileSync(v, "utf8") : v;
}

function need(env: NodeJS.ProcessEnv, k: string): string {
  const v = env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}
