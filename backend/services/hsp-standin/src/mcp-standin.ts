import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type Account, type Address, type Hex, createPublicClient, createWalletClient, isAddressEqual, recoverTypedDataAddress } from "viem";
import { EIP3009_TYPES, HSP_MCP_TOOLS, chainFor, decimalToUnits, eip3009Abi, hspHash, readTokenDomain, rpcTransport, unitsToDecimal, validateCartContents, type HspCartContents } from "@sealed/core";

/**
 * "HSP local stand-in", MCP flavour: DEVELOPMENT ONLY, not operated by HashKey. Mimics the eight
 * tools of HSP Agentic Payment (hsp-agentic-payment_EN.md): create_order -> prepare_payment (typed
 * data with a gateway-chosen nonce) -> finalize_payment -> submit_payment (the "gateway" relays the
 * transferWithAuthorization on the dev chain) -> query_payment (payment-submitted ... finalized).
 * It exists so the whole Sealed flow can be tested without HSP; it proves nothing about HSP itself.
 */
export interface McpStandInConfig {
  chainId: number;
  rpcUrl: string;
  token: Address;
  decimals: number;
  relayer: Account;
  networkName?: string;
  coin?: string;
  /** added on top of the order amount in prepare_payment, to test that the buyer refuses fees */
  feeUnits?: bigint;
  /** delay between status steps after submit */
  stepMs?: number;
}

interface Order {
  flowId: string;
  merchantName: string;
  payTo: Address;
  cart: { contents: HspCartContents };
  amount: bigint;
  status: string;
  reason: string | null;
  tx: string | null;
  payer: string | null;
  quote?: { typed: unknown; payer: Address; value: bigint; expires: number; id: string };
}

const obj = { type: "object" };
const TOOLS: Tool[] = [
  { name: "get_chain_config", description: "Supported networks and tokens.", inputSchema: { type: "object", properties: {} } },
  {
    name: "create_order",
    description: "Create an order from a cart mandate (no merchant_authorization).",
    inputSchema: { type: "object", properties: { merchant_name: { type: "string" }, pay_to: { type: "string" }, cart_mandate: obj }, required: ["merchant_name", "pay_to", "cart_mandate"] },
  },
  { name: "get_order", description: "Read an order.", inputSchema: { type: "object", properties: { flow_id: { type: "string" } }, required: ["flow_id"] } },
  {
    name: "prepare_payment",
    description: "Lock a quote and return the typed data to sign.",
    inputSchema: { type: "object", properties: { flow_id: { type: "string" }, payer_address: { type: "string" }, protocol: { type: "string" } }, required: ["flow_id", "payer_address", "protocol"] },
  },
  {
    name: "finalize_payment",
    description: "Insert the signature and build the payment mandate.",
    inputSchema: { type: "object", properties: { signature: { type: "string" }, payment_payload: obj, payment_mandate_contents: obj, cart_hash: { type: "string" } }, required: ["signature", "payment_payload", "payment_mandate_contents", "cart_hash"] },
  },
  { name: "estimate_fee", description: "Estimate the network fee.", inputSchema: { type: "object", properties: { flow_id: { type: "string" } } } },
  { name: "submit_payment", description: "Submit a finalized payment mandate.", inputSchema: { type: "object", properties: { payment_mandate_json: { type: "string" } }, required: ["payment_mandate_json"] } },
  {
    name: "query_payment",
    description: "Status of a payment.",
    inputSchema: { type: "object", properties: { flow_id: { type: "string" }, payment_request_id: { type: "string" }, expected_merchant_name: { type: "string" } }, required: ["expected_merchant_name"] },
  },
];

export function buildMcpStandIn(cfg: McpStandInConfig) {
  if (cfg.chainId === 177) throw new Error("HSP local stand-in must not run against mainnet");
  const chain = chainFor(cfg.chainId, cfg.rpcUrl);
  const pub = createPublicClient({ chain, transport: rpcTransport(cfg.rpcUrl) });
  const wallet = createWalletClient({ chain, transport: rpcTransport(cfg.rpcUrl), account: cfg.relayer });
  const orders = new Map<string, Order>();
  const stepMs = cfg.stepMs ?? 40;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const network = cfg.networkName ?? "local";
  const coin = cfg.coin ?? "dUSDC";

  const ok = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });
  const err = (m: string) => ({ isError: true, content: [{ type: "text" as const, text: m }] });

  const byFlow = (id: unknown) => orders.get(String(id ?? ""));
  const record = (o: Order) => ({
    flow_id: o.flowId,
    payment_request_id: o.cart.contents.payment_request.details.id,
    status: o.status,
    status_reason: o.reason,
    network,
    order_amount: unitsToDecimal(o.amount, cfg.decimals),
    pay_amount: unitsToDecimal(o.quote?.value ?? o.amount, cfg.decimals),
    to_pay_address: o.payTo,
    payer_address: o.payer,
    tx_signature: o.tx ?? "",
  });

  async function relay(o: Order, mandate: { typed: { domain: Record<string, unknown>; message: Record<string, string> }; signature: Hex }) {
    const m = mandate.typed.message;
    try {
      await sleep(stepMs);
      o.status = "payment-verified";
      const hash = await wallet.writeContract({
        address: cfg.token,
        abi: eip3009Abi,
        functionName: "transferWithAuthorization",
        args: [m.from as Address, m.to as Address, BigInt(m.value!), BigInt(m.validAfter!), BigInt(m.validBefore!), m.nonce as Hex, mandate.signature],
        chain,
        account: cfg.relayer,
      });
      o.status = "payment-processing";
      await sleep(stepMs);
      o.status = "payment-included";
      o.tx = hash;
      const rc = await pub.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") {
        o.status = "payment-failed";
        o.reason = "transfer reverted";
        return;
      }
      await sleep(stepMs);
      o.status = "payment-safe";
      await sleep(stepMs);
      o.status = "payment-finalized";
    } catch (e) {
      o.status = "payment-failed";
      o.reason = (e as Error).message.slice(0, 200);
    }
  }

  async function handle(name: string, a: Record<string, unknown>) {
    switch (name) {
      case "get_chain_config":
        return ok({ networks: [{ network, chain_id: cfg.chainId, tokens: [{ symbol: coin, address: cfg.token, decimals: cfg.decimals, payment_protocol: "eip3009" }] }] });
      case "create_order": {
        const cart = (typeof a.cart_mandate === "string" ? JSON.parse(a.cart_mandate) : a.cart_mandate) as { contents?: HspCartContents; merchant_authorization?: unknown };
        if (!cart?.contents) return err("cart_mandate.contents required");
        if (cart.merchant_authorization !== undefined) return err("do not provide merchant_authorization");
        if (typeof a.pay_to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a.pay_to)) return err("pay_to must be a 42-character address");
        if (!a.merchant_name) return err("merchant_name required");
        const problems = validateCartContents(cart.contents, { checkTokens: false });
        if (problems.length) return err(`10001 invalid cart: ${problems.join("; ")}`);
        const c = cart.contents;
        if ([...orders.values()].some((o) => o.cart.contents.id === c.id)) return err("40001 duplicate cart_mandate_id");
        if ([...orders.values()].some((o) => o.cart.contents.payment_request.details.id === c.payment_request.details.id)) return err("10004 duplicate payment_request_id");
        const md = c.payment_request.method_data[0]!.data;
        if (md.chain_id !== cfg.chainId || !isAddressEqual(md.contract_address, cfg.token)) return err("unsupported chain or token");
        md.pay_to = a.pay_to as Address; // the server applies the separately supplied pay_to
        const flowId = randomBytes(16).toString("hex");
        orders.set(flowId, {
          flowId,
          merchantName: String(a.merchant_name),
          payTo: a.pay_to as Address,
          cart: { contents: c },
          amount: decimalToUnits(c.payment_request.details.total.amount.value, cfg.decimals),
          status: "payment-required",
          reason: null,
          tx: null,
          payer: null,
        });
        return ok({ flow_id: flowId, payment_request_id: c.payment_request.details.id, payment_url: `https://standin.invalid/pay/${flowId}` });
      }
      case "get_order": {
        const o = byFlow(a.flow_id);
        return o ? ok({ ...record(o), cart_mandate: o.cart }) : err("unknown flow");
      }
      case "prepare_payment": {
        const o = byFlow(a.flow_id);
        if (!o) return err("unknown flow");
        if (a.protocol !== "eip3009") return err("protocol must match the token's payment_protocol (eip3009)");
        if (typeof a.payer_address !== "string") return err("payer required");
        if (o.status !== "payment-required") return err(`order is ${o.status}`);
        const value = o.amount + (cfg.feeUnits ?? 0n);
        const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
        const now = Math.floor(Date.now() / 1000);
        const domain = { ...(await readTokenDomain(pub, cfg.token)), chainId: cfg.chainId, verifyingContract: cfg.token };
        const message = { from: a.payer_address, to: o.payTo, value: value.toString(), validAfter: "0", validBefore: String(now + 600), nonce };
        const typed = { domain, types: EIP3009_TYPES, primaryType: "TransferWithAuthorization", message };
        const id = randomUUID();
        o.quote = { typed, payer: a.payer_address as Address, value, expires: Date.now() + 300_000, id };
        return ok({
          eip712: typed,
          cart_hash: hspHash(o.cart.contents),
          token_total_raw: value.toString(),
          quote_expires_at: new Date(o.quote.expires).toISOString(),
          pay_to: o.payTo,
          payer: a.payer_address,
          payment_request_id: o.cart.contents.payment_request.details.id,
          payment_payload: { payload: { signature: "" } },
          payment_mandate_contents: { flow_id: o.flowId, quote_id: id },
        });
      }
      case "finalize_payment": {
        const contents = (typeof a.payment_mandate_contents === "string" ? JSON.parse(a.payment_mandate_contents) : a.payment_mandate_contents) as { flow_id?: string; quote_id?: string };
        const o = byFlow(contents?.flow_id);
        if (!o?.quote || o.quote.id !== contents.quote_id) return err("unknown quote");
        if (Date.now() > o.quote.expires) return err("30043 quote expired");
        const t = o.quote.typed as { domain: Record<string, unknown>; types: typeof EIP3009_TYPES; message: Record<string, string> };
        const signer = await recoverTypedDataAddress({
          domain: t.domain as never,
          types: t.types,
          primaryType: "TransferWithAuthorization",
          message: { ...t.message, value: BigInt(t.message.value!), validAfter: 0n, validBefore: BigInt(t.message.validBefore!) } as never,
          signature: a.signature as Hex,
        }).catch(() => null);
        if (!signer || !isAddressEqual(signer, o.quote.payer)) return err("signature does not match the payer");
        return ok({ payment_mandate_json: JSON.stringify({ flow_id: o.flowId, quote_id: o.quote.id, signature: a.signature }) });
      }
      case "estimate_fee":
        return ok({ gas_fee: "0.00", gas_fee_advanced: !cfg.feeUnits });
      case "submit_payment": {
        const m = JSON.parse(String(a.payment_mandate_json)) as { flow_id: string; quote_id: string; signature: Hex };
        const o = byFlow(m.flow_id);
        if (!o?.quote || o.quote.id !== m.quote_id) return err("unknown payment mandate");
        if (o.status !== "payment-required") return err(`payment already ${o.status}`);
        o.status = "payment-submitted";
        o.payer = o.quote.payer;
        void relay(o, { typed: o.quote.typed as never, signature: m.signature });
        return ok({ status: "payment-submitted", flow_id: o.flowId });
      }
      case "query_payment": {
        const o = byFlow(a.flow_id) ?? [...orders.values()].find((x) => x.cart.contents.payment_request.details.id === a.payment_request_id);
        if (!o) return err("unknown payment");
        return ok({ payment: record(o), attribution_verified: a.expected_merchant_name === o.merchantName });
      }
      default:
        return err(`unknown tool ${name}`);
    }
  }

  const makeServer = () => {
    const server = new Server({ name: "hsp-standin", version: "0.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => handle(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>));
    return server;
  };

  return {
    orders,
    tools: HSP_MCP_TOOLS,
    /** A client-side transport wired to a fresh server over memory (tests). */
    connect(): Transport {
      const [client, server] = InMemoryTransport.createLinkedPair();
      void makeServer().connect(server);
      return client;
    },
    /** Streamable HTTP, stateless: one server per request. */
    listen(port: number): Promise<HttpServer> {
      const http = createServer((req, res) => {
        if (req.url === "/health") return void res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", async () => {
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          const server = makeServer();
          res.on("close", () => void server.close());
          await server.connect(transport);
          let body: unknown;
          try {
            body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
          } catch {
            return void res.writeHead(400).end();
          }
          await transport.handleRequest(req, res, body);
        });
      });
      return new Promise((resolve) => http.listen(port, "127.0.0.1", () => resolve(http)));
    },
  };
}
