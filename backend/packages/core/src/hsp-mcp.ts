import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type Address, type Hex, type LocalAccount, isAddressEqual } from "viem";
import { HspApiError } from "./hsp-client.ts";
import type { HspCartContents, HspCreateOrderResult, HspPaymentRecord } from "./hsp.ts";

/*
 * HSP Agentic Payment (QA): the hackathon route to HSP. A hosted MCP server (Streamable HTTP) holds the
 * App Key/Secret and the merchant key, so Sealed sends no credentials. Eight tools:
 *   get_chain_config, create_order, get_order            (merchant: build the order)
 *   prepare_payment -> sign eip712 -> finalize_payment -> submit_payment   (payer: pay it)
 *   estimate_fee, query_payment                          (fees, status; there are no webhooks)
 * Official guide: hsp-agentic-payment_EN.md (2026-10-30). Tool argument names are read from the live
 * input schemas (the guide says to), so a renamed argument fails loudly instead of sending nonsense.
 */

export const HSP_MCP_TOOLS = ["get_chain_config", "create_order", "get_order", "prepare_payment", "finalize_payment", "estimate_fee", "submit_payment", "query_payment"] as const;
export type HspMcpTool = (typeof HSP_MCP_TOOLS)[number];

/** Names a caller may use for an argument -> other spellings the live schema might use. */
const ALIASES: Record<string, string[]> = {
  payer: ["payer", "payer_address", "payeraddress", "from"],
  flow_id: ["flow_id", "flowid"],
  merchant_name: ["merchant_name", "merchantname"],
  expected_merchant_name: ["expected_merchant_name", "expectedmerchantname"],
};

const norm = (s: string) => s.toLowerCase().replaceAll("_", "").replaceAll("-", "");

type ToolSchema = { properties?: Record<string, { type?: string | string[] }>; required?: string[] };

/** Fits our arguments to a tool's live schema: renames known aliases, stringifies where a string is wanted, refuses unknowns and gaps. */
export function fitArguments(tool: string, schema: ToolSchema | undefined, args: Record<string, unknown>): Record<string, unknown> {
  const props = schema?.properties;
  if (!props || Object.keys(props).length === 0) return args;
  const byNorm = new Map(Object.keys(props).map((k) => [norm(k), k]));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    const target = props[k] ? k : (ALIASES[k] ?? [k]).map((a) => byNorm.get(norm(a))).find(Boolean);
    if (!target) throw new HspApiError(`HSP MCP ${tool}: the live schema has no argument for "${k}" (it has: ${Object.keys(props).join(", ")})`, false);
    const t = props[target]!.type;
    const wantsString = t === "string" || (Array.isArray(t) && t.includes("string") && !t.includes("object"));
    out[target] = wantsString && typeof v === "object" && v !== null ? JSON.stringify(v) : v;
  }
  const missing = (schema?.required ?? []).filter((k) => out[k] === undefined);
  if (missing.length) throw new HspApiError(`HSP MCP ${tool}: the live schema also requires ${missing.join(", ")}, which Sealed does not supply`, false);
  return out;
}

/** Unwraps a tool result: structuredContent or JSON text, and the `{code,msg,data}` envelope if present. */
export function parseToolResult(tool: string, r: { isError?: boolean; content?: unknown; structuredContent?: unknown }): unknown {
  const text = ((r.content as { type: string; text?: string }[] | undefined) ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  if (r.isError) throw new HspApiError(`HSP MCP ${tool} failed: ${text.slice(0, 500)}`, false);
  let v: unknown = r.structuredContent;
  if (v === undefined) {
    try {
      v = JSON.parse(text);
    } catch {
      throw new HspApiError(`HSP MCP ${tool}: non-JSON result: ${text.slice(0, 200)}`, false);
    }
  }
  if (v && typeof v === "object" && "code" in v && ("data" in v || "msg" in v)) {
    const e = v as { code: number | string; msg?: string; data?: unknown };
    if (e.code !== 0 && e.code !== "0" && e.code !== 200) throw new HspApiError(`HSP MCP ${tool}: code ${e.code}: ${e.msg ?? ""}`, false);
    return e.data;
  }
  return v;
}

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined);

/** What get_chain_config says about one token: network name, protocol, decimals, symbol. */
export interface HspChainToken {
  network: string;
  chainId: number;
  address: Address;
  symbol: string;
  decimals: number;
  protocol: string;
}

/** Walks get_chain_config's result for the entry whose address is `token`; the shape is not documented, so it searches. */
export function findChainToken(config: unknown, chainId: number, token: Address): HspChainToken | null {
  let found: HspChainToken | null = null;
  const walk = (node: unknown, ancestors: Record<string, unknown>[]) => {
    if (found || node === null || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (!Array.isArray(node) && typeof o.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(o.address) && isAddressEqual(o.address as Address, token)) {
      const net = [...ancestors].reverse().find((a) => Number(a.chain_id ?? a.chainId) === chainId) ?? ancestors.at(-1) ?? {};
      const id = Number(net.chain_id ?? net.chainId ?? o.chain_id ?? chainId);
      if (id === chainId) {
        found = {
          network: str(net.network) ?? str(net.name) ?? str(net.key) ?? str(o.network) ?? "",
          chainId: id,
          address: o.address as Address,
          symbol: str(o.symbol) ?? str(o.coin) ?? str(o.name) ?? "",
          decimals: Number(o.decimals),
          protocol: str(o.payment_protocol) ?? str(o.protocol) ?? "",
        };
        return;
      }
    }
    for (const v of Object.values(o)) walk(v, Array.isArray(node) ? ancestors : [...ancestors, o]);
  };
  walk(config, []);
  return found;
}

/** Problems with the pinned token against what HSP says it supports (empty = fine). */
export function chainTokenProblems(t: HspChainToken | null, o: { decimals: number }): string[] {
  if (!t) return ["HSP's get_chain_config does not list the pinned token on this chain"];
  const p: string[] = [];
  if (t.protocol.toLowerCase() !== "eip3009") p.push(`HSP lists the pinned token with protocol "${t.protocol}"; the escrow needs eip3009`);
  if (t.decimals !== o.decimals) p.push(`HSP says the token has ${t.decimals} decimals, config says ${o.decimals}`);
  return p;
}

/** EIP-712 typed data as prepare_payment returns it (numbers arrive as strings). */
export interface HspTypedData {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** Converts uint/int message fields to bigint, which is what viem signs. */
export function coerceTypedData(td: HspTypedData): HspTypedData {
  const fields = td.types[td.primaryType] ?? [];
  const message = { ...td.message };
  for (const f of fields) if (/^u?int\d*$/.test(f.type) && message[f.name] !== undefined) message[f.name] = BigInt(message[f.name] as string | number | bigint);
  const domain = { ...td.domain };
  if (domain.chainId !== undefined) domain.chainId = BigInt(domain.chainId as string | number);
  return { ...td, domain, message };
}

export interface PreparedPayment {
  eip712: HspTypedData;
  cart_hash: string;
  token_total_raw: string;
  quote_expires_at?: string;
  pay_to: Address;
  payer: Address;
  payment_request_id: string;
  payment_payload: unknown;
  payment_mandate_contents: unknown;
}

export interface PayCheck {
  chainId: number;
  token: Address;
  escrow: Address;
  payer: Address;
  /** the session cap in token base units: the buyer signs this and nothing else */
  amount: bigint;
  /** the signature must not stay valid longer than this many seconds from now */
  maxValiditySeconds?: number;
}

/**
 * What the buyer is about to sign, checked against the session: exactly the authorization it
 * expects, not just whatever the gateway quoted. Returns why not, or null if it matches.
 */
export function checkPreparedPayment(p: PreparedPayment, e: PayCheck, now = Date.now()): string | null {
  const td = p.eip712;
  if (!td?.message || !td.domain || !td.types) return "prepare_payment returned no EIP-712 data";
  if (td.primaryType !== "TransferWithAuthorization") return `unexpected signing type ${td.primaryType}`;
  const m = td.message as Record<string, string>;
  if (Number(td.domain.chainId) !== e.chainId) return "wrong chain";
  if (typeof td.domain.verifyingContract !== "string" || !isAddressEqual(td.domain.verifyingContract as Address, e.token)) return "wrong token";
  if (!m.from || !isAddressEqual(m.from as Address, e.payer)) return "authorization is not from the buyer";
  if (!m.to || !isAddressEqual(m.to as Address, e.escrow)) return "payee is not the session escrow";
  let value: bigint;
  try {
    value = BigInt(m.value ?? "");
  } catch {
    return "authorization has no amount";
  }
  if (value !== e.amount) return `authorization is for ${value}, the session cap is ${e.amount} (fees added?)`;
  if (p.token_total_raw !== undefined && BigInt(p.token_total_raw) !== e.amount) return `HSP token_total_raw ${p.token_total_raw} differs from the session cap ${e.amount}`;
  if (p.pay_to && !isAddressEqual(p.pay_to, e.escrow)) return "HSP pay_to is not the session escrow";
  const validBefore = Number(m.validBefore);
  if (!Number.isFinite(validBefore) || validBefore * 1000 < now) return "authorization already expired";
  if (e.maxValiditySeconds !== undefined && validBefore * 1000 > now + e.maxValiditySeconds * 1000) return "authorization stays valid too long";
  return null;
}

/** Client for HSP Agentic Payment. Pass `transport` in tests; otherwise it connects to `url` over Streamable HTTP. */
export class HspMcpClient {
  private client?: Client;
  private schemas = new Map<string, ToolSchema>();
  private connecting?: Promise<void>;

  constructor(readonly opts: { url?: string; transport?: () => Transport; merchantName: string }) {}

  private connect(): Promise<void> {
    this.connecting ??= (async () => {
      const transport = this.opts.transport ? this.opts.transport() : new StreamableHTTPClientTransport(new URL(this.opts.url!));
      const client = new Client({ name: "sealed", version: "0.1.0" });
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        const missing = HSP_MCP_TOOLS.filter((t) => !tools.some((x) => x.name === t));
        if (missing.length) throw new HspApiError(`HSP MCP is missing tools: ${missing.join(", ")} (do not proceed without finalize_payment)`, false);
        for (const t of tools) this.schemas.set(t.name, t.inputSchema as ToolSchema);
        this.client = client;
      } catch (e) {
        this.connecting = undefined;
        await client.close().catch(() => undefined);
        if (e instanceof HspApiError) throw e;
        throw new HspApiError(`HSP MCP unreachable (is this machine's egress IP allowlisted by HSP?): ${(e as Error).message}`, true);
      }
    })();
    return this.connecting;
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
    this.connecting = undefined;
  }

  /** Calls one tool with arguments fitted to its live schema. */
  async call(tool: HspMcpTool, args: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    const fitted = fitArguments(tool, this.schemas.get(tool), args);
    try {
      return parseToolResult(tool, (await this.client!.callTool({ name: tool, arguments: fitted })) as never);
    } catch (e) {
      if (e instanceof HspApiError) throw e;
      throw new HspApiError(`HSP MCP ${tool}: ${(e as Error).message}`, true);
    }
  }

  /** The names and live input schemas of the tools, for the readiness check. */
  async toolSchemas(): Promise<Record<string, ToolSchema>> {
    await this.connect();
    return Object.fromEntries(this.schemas);
  }

  getChainConfig(): Promise<unknown> {
    return this.call("get_chain_config", {});
  }

  /** Merchant side: the cart goes without merchant_authorization; HSP signs for us and applies pay_to. */
  async createOrder(contents: HspCartContents, payTo: Address): Promise<HspCreateOrderResult> {
    const d = asObj(await this.call("create_order", { merchant_name: this.opts.merchantName, pay_to: payTo, cart_mandate: { contents } }));
    const flowId = str(d.flow_id);
    if (!flowId) throw new HspApiError("HSP create_order returned no flow_id", false);
    return { flow_id: flowId, payment_request_id: str(d.payment_request_id), payment_url: str(d.payment_url), cart_mandate_id: contents.id };
  }

  getOrder(flowId: string): Promise<unknown> {
    return this.call("get_order", { flow_id: flowId });
  }

  /** Status of one payment, in the record shape the coordinator already understands. */
  async payment(flowId: string, o: { cartMandateId: string; paymentRequestId: string }): Promise<HspPaymentRecord & { attribution_verified: boolean }> {
    const d = asObj(await this.call("query_payment", { flow_id: flowId, expected_merchant_name: this.opts.merchantName }));
    const p = asObj(d.payment ?? d);
    return {
      ...p,
      payment_request_id: str(p.payment_request_id) ?? o.paymentRequestId,
      cart_mandate_id: o.cartMandateId,
      flow_id: flowId,
      status: str(p.status) ?? "",
      status_reason: str(p.status_reason) ?? null,
      tx_signature: str(p.tx_signature) ?? null,
      payer_address: str(p.payer_address),
      pay_to: str(p.to_pay_address) ?? str(p.pay_to),
      order_amount: str(p.order_amount),
      pay_amount: str(p.pay_amount),
      attribution_verified: d.attribution_verified === true,
    };
  }

  /**
   * Payer side: prepare -> check what will be signed -> sign -> finalize -> submit. Nothing is signed or
   * submitted unless `check` accepts the quote; the quote is re-prepared once if it expired.
   */
  async pay(flowId: string, payer: LocalAccount, check: Omit<PayCheck, "payer">): Promise<{ status: string; tokenTotalRaw: string; submitted: unknown }> {
    for (let attempt = 0; ; attempt++) {
      const p = asObj(await this.call("prepare_payment", { flow_id: flowId, payer: payer.address, protocol: "eip3009" })) as unknown as PreparedPayment;
      const bad = checkPreparedPayment(p, { ...check, payer: payer.address });
      if (bad) throw new HspApiError(`refused to sign: ${bad}`, false);
      const td = coerceTypedData(p.eip712);
      const signature: Hex = await payer.signTypedData({ domain: td.domain, types: td.types, primaryType: td.primaryType, message: td.message } as never);
      try {
        const fin = asObj(
          await this.call("finalize_payment", { signature, payment_payload: p.payment_payload, payment_mandate_contents: p.payment_mandate_contents, cart_hash: p.cart_hash }),
        );
        const json = fin.payment_mandate_json;
        if (json === undefined) throw new HspApiError("HSP finalize_payment returned no payment_mandate_json", false);
        const submitted = asObj(await this.call("submit_payment", { payment_mandate_json: json }));
        return { status: str(submitted.status) ?? str(asObj(submitted.payment).status) ?? "payment-submitted", tokenTotalRaw: p.token_total_raw, submitted };
      } catch (e) {
        // expired quote or gateway code 30043: prepare again and sign the new typed data; never reuse the old signature
        if (attempt === 0 && /30043|expired/i.test((e as Error).message)) continue;
        throw e;
      }
    }
  }
}
