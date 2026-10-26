import { randomBytes, type KeyObject } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { type Account, type Address, type PublicClient, createPublicClient, createWalletClient, http, isAddressEqual, recoverTypedDataAddress } from "viem";
import {
  EIP3009_TYPES,
  type HspCartMandate,
  type HspConfig,
  type HspPaymentMandate,
  type HspPaymentRecord,
  chainFor,
  checkSignedRequest,
  decimalToUnits,
  decodeX402,
  eip3009Abi,
  hspHash,
  openDb,
  type Db,
  readTokenDomain,
  signWebhook,
  verifyEs256k,
  verifyHs256,
} from "@sealed/core";

/**
 * "HSP local stand-in" — DEVELOPMENT ONLY. Not operated by HashKey.
 *
 * Serves the HSP endpoints Sealed uses (merchant orders + payment status, HMAC-authenticated;
 * payer cart lookup + pay-mandate) and does what HSP does with a payment mandate: verifies the
 * merchant JWT, the payer's user_authorization and EIP-3009 signature against the cart, relays
 * the transfer on chain and reports status by signed webhook. Transfers it relays are real
 * on-chain token transfers on the dev chain. Enabled only with HSP_LOCAL_STANDIN=1 and refused on
 * mainnet. The wire format mirrors packages/core/src/hsp.ts, so it carries the same
 * TODO(HSP-DOCS) caveats.
 */
export const STANDIN_LABEL = "HSP local stand-in";

export interface StandInMerchant {
  name: string;
  appKey: string;
  appSecret: string;
  webhookSecret: string;
  publicKey: KeyObject;
  webhookUrl?: string;
}

export interface StandInConfig {
  chainId: number;
  rpcUrl: string;
  token: Address;
  decimals: number;
  hsp: Pick<HspConfig, "paths" | "headers" | "x402Method" | "jwtAudience" | "networkName" | "webhookEventIdField">;
  relayer: Account;
  merchants: StandInMerchant[];
  publicUrl: string;
  dbPath: string;
}

interface FlowRow {
  flow_id: string;
  app_key: string;
  cart_mandate_id: string;
  payment_request_id: string;
  cart_json: string;
  amount: string;
  status: string;
  status_reason: string | null;
  payer: string | null;
  tx: string | null;
}

const ok = (data: unknown) => ({ code: 0, msg: "success", data });
const fail = (code: number, msg: string) => ({ code, msg });

export function buildStandIn(cfg: StandInConfig): FastifyInstance & { pub: PublicClient } {
  if (cfg.chainId === 177) throw new Error(`${STANDIN_LABEL} must not run against mainnet`);
  const db: Db = openDb(
    cfg.dbPath,
    `CREATE TABLE IF NOT EXISTS flows (
      flow_id TEXT PRIMARY KEY, app_key TEXT NOT NULL, cart_mandate_id TEXT NOT NULL UNIQUE, payment_request_id TEXT NOT NULL,
      cart_json TEXT NOT NULL, amount TEXT NOT NULL, status TEXT NOT NULL, status_reason TEXT, payer TEXT, tx TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
  );
  const chain = chainFor(cfg.chainId, cfg.rpcUrl);
  const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) }) as PublicClient;
  const wallet = createWalletClient({ chain, transport: http(cfg.rpcUrl), account: cfg.relayer });
  const app = Fastify({ logger: false }) as unknown as FastifyInstance & { pub: PublicClient };
  app.decorate("pub", pub);

  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, { raw: body as string, json: body ? JSON.parse(body as string) : {} });
    } catch (e) {
      done(e as Error);
    }
  });
  app.addHook("onSend", async (_req, reply) => {
    reply.header("x-hsp-standin", STANDIN_LABEL);
  });

  const H = cfg.hsp.headers;
  const merchantFor = (req: { method: string; url: string; headers: Record<string, unknown>; body?: unknown }): StandInMerchant | string => {
    const appKey = String(req.headers[H.appKey.toLowerCase()] ?? "");
    const m = cfg.merchants.find((x) => x.appKey === appKey);
    if (!m) return "unknown app key";
    const [path, query = ""] = req.url.split("?");
    const raw = (req.body as { raw?: string } | undefined)?.raw ?? "";
    const err = checkSignedRequest(
      { appKey, timestamp: String(req.headers[H.timestamp.toLowerCase()] ?? ""), nonce: String(req.headers[H.nonce.toLowerCase()] ?? ""), signature: String(req.headers[H.signature.toLowerCase()] ?? "") },
      { method: req.method, path: path!, query, body: raw },
      { appKey: m.appKey, secret: m.appSecret },
    );
    return err ?? m;
  };

  const flow = (col: "flow_id" | "cart_mandate_id" | "payment_request_id", v: string) =>
    db.prepare(`SELECT * FROM flows WHERE ${col} = ? ORDER BY created_at DESC LIMIT 1`).get(v) as FlowRow | undefined;

  const record = (f: FlowRow): HspPaymentRecord => {
    const cart = JSON.parse(f.cart_json) as HspCartMandate;
    const m = cart.contents.payment_request.method_data[0]!.data;
    return {
      payment_request_id: f.payment_request_id,
      cart_mandate_id: f.cart_mandate_id,
      flow_id: f.flow_id,
      status: f.status,
      status_reason: f.status_reason,
      amount: f.amount,
      token_address: m.contract_address,
      chain_id: m.chain_id,
      payer_address: f.payer ?? undefined,
      pay_to: m.pay_to,
      tx_signature: f.tx,
      payment_url: `${cfg.publicUrl}/checkout/${f.flow_id}`,
    };
  };

  const setStatus = async (flowId: string, status: string, extra: { reason?: string; tx?: string; payer?: string } = {}) => {
    db.prepare("UPDATE flows SET status = ?, status_reason = ?, tx = COALESCE(?, tx), payer = COALESCE(?, payer), updated_at = ? WHERE flow_id = ?").run(
      status,
      extra.reason ?? null,
      extra.tx ?? null,
      extra.payer ?? null,
      Date.now(),
      flowId,
    );
    const f = flow("flow_id", flowId)!;
    const m = cfg.merchants.find((x) => x.appKey === f.app_key);
    if (!m?.webhookUrl) return;
    const body = JSON.stringify({ [cfg.hsp.webhookEventIdField]: `evt_${f.flow_id}_${status}_${randomBytes(4).toString("hex")}`, ...record(f) });
    try {
      await fetch(m.webhookUrl, { method: "POST", headers: { "content-type": "application/json", [H.webhookSignature]: signWebhook(m.webhookSecret, body) }, body, signal: AbortSignal.timeout(5_000) });
    } catch {
      // merchants also poll the status endpoint
    }
  };

  // ---------------------------------------------------------------- merchant API

  app.post(cfg.hsp.paths.createOrder, async (req) => {
    const m = merchantFor(req as never);
    if (typeof m === "string") return fail(40100, m);
    const cart = ((req.body as { json: { cart_mandate?: HspCartMandate } }).json ?? {}).cart_mandate;
    if (!cart?.contents || typeof cart.merchant_authorization !== "string") return fail(40001, "cart_mandate required");
    const claims = verifyEs256k(cart.merchant_authorization, m.publicKey);
    if (!claims) return fail(40101, "merchant_authorization signature invalid");
    if (claims.aud !== cfg.hsp.jwtAudience) return fail(40102, "bad audience");
    if (claims.cart_hash !== hspHash(cart.contents)) return fail(40103, "cart_hash mismatch");
    if (typeof claims.exp === "number" && claims.exp < Date.now() / 1000) return fail(40104, "merchant_authorization expired");
    const md = cart.contents.payment_request.method_data.find((x) => x.supported_methods === cfg.hsp.x402Method);
    if (!md) return fail(40002, "no x402 method");
    if (md.data.chain_id !== cfg.chainId) return fail(40003, "unsupported chain");
    if (!isAddressEqual(md.data.contract_address, cfg.token)) return fail(40004, "unsupported token");
    let amount: bigint;
    try {
      amount = decimalToUnits(cart.contents.payment_request.details.total.amount.value, cfg.decimals);
    } catch (e) {
      return fail(40005, (e as Error).message);
    }
    const existing = flow("cart_mandate_id", cart.contents.id);
    if (existing) {
      if (existing.cart_json !== JSON.stringify(cart)) return fail(40901, "cart_mandate id reused for a different cart");
      return ok({ flow_id: existing.flow_id, payment_url: record(existing).payment_url, cart_mandate_id: existing.cart_mandate_id, payment_request_id: existing.payment_request_id });
    }
    const flowId = randomBytes(16).toString("hex");
    const now = Date.now();
    db.prepare(
      "INSERT INTO flows (flow_id, app_key, cart_mandate_id, payment_request_id, cart_json, amount, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'payment-required', ?, ?)",
    ).run(flowId, m.appKey, cart.contents.id, cart.contents.payment_request.details.id, JSON.stringify(cart), amount.toString(), now, now);
    return ok({ flow_id: flowId, payment_url: `${cfg.publicUrl}/checkout/${flowId}`, cart_mandate_id: cart.contents.id, payment_request_id: cart.contents.payment_request.details.id });
  });

  app.get(cfg.hsp.paths.payments, async (req) => {
    const m = merchantFor(req as never);
    if (typeof m === "string") return fail(40100, m);
    const q = req.query as Record<string, string | undefined>;
    const key = (["cart_mandate_id", "payment_request_id", "flow_id"] as const).find((k) => q[k]);
    if (!key) return fail(40006, "query by cart_mandate_id, payment_request_id or flow_id");
    const rows = db.prepare(`SELECT * FROM flows WHERE ${key} = ? AND app_key = ?`).all(q[key]!, m.appKey) as unknown as FlowRow[];
    return ok(rows.map(record));
  });

  // ---------------------------------------------------------------- payer API

  app.get(cfg.hsp.paths.cartByFlow.replace("{flowId}", ":flowId"), async (req) => {
    const f = flow("flow_id", (req.params as { flowId: string }).flowId);
    return f ? ok({ flow_id: f.flow_id, status: f.status, cartmandate: JSON.parse(f.cart_json) }) : fail(40401, "unknown flow");
  });

  app.post(cfg.hsp.paths.payMandate, async (req) => {
    const body = (req.body as { json: { flow_id?: string; payment_mandate?: HspPaymentMandate } }).json ?? {};
    const f = body.flow_id ? flow("flow_id", body.flow_id) : undefined;
    if (!f) return fail(40401, "unknown flow");
    if (f.status !== "payment-required" && f.status !== "payment-failed") return fail(40902, `payment already ${f.status}`);
    const pm = body.payment_mandate;
    if (!pm?.payment_mandate_contents || typeof pm.user_authorization !== "string") return fail(40010, "payment mandate required");
    const cart = JSON.parse(f.cart_json) as HspCartMandate;
    const md = cart.contents.payment_request.method_data[0]!.data;
    const pmc = pm.payment_mandate_contents;
    if (pmc.payment_mandate_id !== cart.contents.payment_request.details.id) return fail(40011, "payment mandate does not match cart");
    if (pmc.payment_response?.method_name !== cfg.hsp.x402Method) return fail(40012, "unsupported method");
    if (pmc.payment_details_total?.amount?.value !== cart.contents.payment_request.details.total.amount.value) return fail(40013, "total mismatch");
    if (new Date(cart.contents.cart_expiry).getTime() < Date.now()) return fail(40014, "cart expired");

    let x;
    try {
      x = decodeX402(pmc.payment_response.details.payment_payload);
    } catch {
      return fail(40015, "bad x402 payload");
    }
    const a = x.payload?.authorization;
    const amount = BigInt(f.amount);
    if (!a || x.x402Version !== 2 || x.accepted?.scheme !== "exact") return fail(40016, "x402 v2 exact required");
    if (x.accepted.network !== `eip155:${md.chain_id}`) return fail(40016, "wrong network");
    if (!isAddressEqual(x.accepted.asset, md.contract_address)) return fail(40016, "wrong asset");
    if (!isAddressEqual(a.to, md.pay_to) || !isAddressEqual(x.accepted.payTo, md.pay_to)) return fail(40016, "authorization does not pay the cart's pay_to");
    if (BigInt(a.value) !== amount || BigInt(x.accepted.amount) !== amount) return fail(40016, "authorization amount != cart total");

    const ua = verifyHs256(pm.user_authorization, Buffer.from(a.from));
    if (!ua || ua.aud !== cfg.hsp.jwtAudience || String(ua.iss).toLowerCase() !== a.from.toLowerCase()) return fail(40102, "user_authorization invalid");
    const td = ua.transaction_data as unknown;
    if (!Array.isArray(td) || td[0] !== hspHash(cart.contents) || td[1] !== hspHash(pmc)) return fail(40104, "user_authorization does not bind these mandates");

    const domain = await readTokenDomain(pub, md.contract_address);
    const message = { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce };
    const signer = await recoverTypedDataAddress({
      domain: { ...domain, chainId: md.chain_id, verifyingContract: md.contract_address },
      types: EIP3009_TYPES,
      primaryType: "TransferWithAuthorization",
      message,
      signature: x.payload.signature,
    }).catch(() => null);
    if (!signer || !isAddressEqual(signer, a.from)) return fail(40106, "authorization signature invalid");

    await setStatus(f.flow_id, "payment-submitted", { payer: a.from });
    try {
      const hash = await wallet.writeContract({
        address: md.contract_address,
        abi: eip3009Abi,
        functionName: "transferWithAuthorization",
        args: [message.from, message.to, message.value, message.validAfter, message.validBefore, message.nonce, x.payload.signature],
        chain,
        account: cfg.relayer,
      });
      await setStatus(f.flow_id, "payment-included", { tx: hash });
      const rc = await pub.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") {
        await setStatus(f.flow_id, "payment-failed", { reason: "transfer reverted", tx: hash });
        return fail(50001, "transfer reverted");
      }
      await setStatus(f.flow_id, "payment-successful", { tx: hash });
      return ok({ ...record(flow("flow_id", f.flow_id)!) });
    } catch (e) {
      await setStatus(f.flow_id, "payment-failed", { reason: (e as Error).message.slice(0, 200) });
      return fail(50002, "relay failed");
    }
  });

  app.get("/health", async () => ({ ok: true, label: STANDIN_LABEL }));
  return app;
}
