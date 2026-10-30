import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  isAddressEqual,
  keccak256,
  stringToHex,
} from "viem";
import { type PrivateKeyAccount } from "viem/accounts";
import {
  CATALOG,
  DELIVERY_SCHEMAS,
  type DealCart,
  type Deployment,
  type HspConfig,
  HspClient,
  HspMcpClient,
  type SignedQuote,
  buildPaymentMandate,
  categoryId,
  chainFor,
  checkCartForSession,
  checkQuote,
  openSessionArgs,
  readTokenDomain,
  sessionEscrowAbi,
  unitsToDecimal, rpcTransport } from "@sealed/core";
import { VaultAgentClient, VaultCallError } from "./vault-client.ts";

export interface BuyerToolsConfig {
  chainId: number;
  rpcUrl: string;
  deployment: Deployment;
  /** buyer wallet: pays gas for SessionEscrow.open and signs the EIP-3009 funding authorization */
  wallet: PrivateKeyAccount;
  vault: VaultAgentClient;
  hsp: Pick<HspConfig, "baseUrl" | "payerBaseUrl" | "paths" | "x402Method" | "jwtAudience"> & Partial<HspConfig>;
  /** HSP Agentic Payment client; built from hsp.mcpUrl when hsp.mode is "mcp" (tests inject one). */
  hspMcp?: HspMcpClient;
  coordinatorUrl: string;
  sellerUrls: string[];
  decimals?: number;
  deliveryTimeoutMs?: number;
  fundingTimeoutMs?: number;
}

export interface DeliveryCheck {
  ok: boolean;
  reasons: string[];
}

/** Deterministic delivery check (README 9.2). A voucher is signed only when this passes. */
export function checkDelivery(o: { serviceId: string; body: string; committedHash: string; latencyMs: number; timeoutMs: number; sessionId: string; expectedCall: number; chainId: number }): DeliveryCheck {
  const reasons: string[] = [];
  if (keccak256(stringToHex(o.body)) !== o.committedHash) reasons.push("delivery hash does not match the pre-committed hash");
  if (o.latencyMs > o.timeoutMs) reasons.push(`latency ${o.latencyMs}ms over ${o.timeoutMs}ms`);
  let parsed: { sessionId?: string; call?: number; chainId?: number } | undefined;
  try {
    parsed = JSON.parse(o.body);
  } catch {
    reasons.push("body is not JSON");
  }
  const schema = DELIVERY_SCHEMAS[o.serviceId];
  if (!schema) reasons.push("no schema for service");
  else if (parsed && !schema.safeParse(parsed).success) reasons.push("body does not match the service schema");
  if (parsed && parsed.sessionId?.toLowerCase() !== o.sessionId.toLowerCase()) reasons.push("delivery is for another session");
  if (parsed && parsed.call !== o.expectedCall) reasons.push("unexpected call number");
  if (parsed && parsed.chainId !== o.chainId) reasons.push("wrong chain");
  return { ok: reasons.length === 0, reasons };
}

interface QuoteRecord {
  sellerUrl: string;
  serviceId: string;
  rfqId: string;
  signed: SignedQuote;
}

interface SessionRecord {
  sessionId: Hex;
  sellerUrl: string;
  serviceId: string;
  calls: number;
  unitPrice: bigint;
  used: number;
  lastCheck?: DeliveryCheck;
}

export type ToolResult = Record<string, unknown>;

/**
 * The buyer agent's tool layer. Plain code, no LLM: the model chooses which tool to call, these
 * functions do the work and every check. Nothing here can read the mandate; money only moves into
 * a SessionEscrow session opened with a Vault proof, and out of it only through vouchers.
 */
export class BuyerTools {
  readonly pub: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly hsp: HspClient;
  private readonly mcp?: HspMcpClient;
  private readonly quotes = new Map<string, QuoteRecord>();
  private readonly negotiations = new Map<string, string>(); // `${seller}|${service}|${rfq}` -> vault negotiation id
  private readonly accepted = new Map<string, string>(); // quote id -> vault negotiation id
  private readonly sessions = new Map<string, SessionRecord>();
  private sellerCards: { url: string; address: Address; name: string }[] = [];
  readonly transcript: { tool: string; input: unknown; output: unknown }[] = [];

  constructor(readonly cfg: BuyerToolsConfig) {
    const chain = chainFor(cfg.chainId, cfg.rpcUrl);
    this.pub = createPublicClient({ chain, transport: rpcTransport(cfg.rpcUrl) }) as PublicClient;
    this.walletClient = createWalletClient({ chain, transport: rpcTransport(cfg.rpcUrl), account: cfg.wallet });
    this.hsp = new HspClient({ appKey: "", appSecret: "", merchantPrivateKey: "", merchantName: "", webhookSecret: "", headers: {} as never, networkName: "", coin: "", webhookEventIdField: "", successStatuses: [], failedStatuses: [], localStandIn: false, ...cfg.hsp });
    if (cfg.hsp.mode === "mcp") this.mcp = cfg.hspMcp ?? new HspMcpClient({ url: cfg.hsp.mcpUrl, merchantName: cfg.hsp.merchantName ?? "Sealed" });
  }

  private get decimals() {
    return this.cfg.decimals ?? 6;
  }

  private fmt(units: bigint) {
    return `${unitsToDecimal(units, this.decimals)} (${units} base units)`;
  }

  private seller(url: string) {
    const s = this.sellerCards.find((c) => c.url === url);
    if (!s) throw new Error("unknown seller url; call discover_sellers first");
    return s;
  }

  private async sellerPost(url: string, path: string, body: unknown) {
    const r = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) throw new Error(`seller ${path}: ${(j.error as string) ?? r.status}`);
    return j;
  }

  /** Runs a tool by name and records input and output in the transcript. */
  async run(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    let output: ToolResult;
    try {
      switch (name) {
        case "discover_sellers":
          output = await this.discoverSellers();
          break;
        case "request_quote":
          output = await this.requestQuote(input as never);
          break;
        case "propose":
          output = await this.propose(input as never);
          break;
        case "open_session":
          output = await this.openSession(input as never);
          break;
        case "call_service":
          output = await this.callService(input as never);
          break;
        case "check_delivery":
          output = this.checkLastDelivery(input as never);
          break;
        case "close_session":
          output = await this.closeSession(input as never);
          break;
        default:
          output = { error: `unknown tool ${name}` };
      }
    } catch (e) {
      output = { error: (e as Error).message };
    }
    this.transcript.push({ tool: name, input, output });
    return output;
  }

  async discoverSellers(): Promise<ToolResult> {
    const cards = await Promise.all(
      this.cfg.sellerUrls.map(async (url) => {
        try {
          const r = await fetch(`${url}/.well-known/agent.json`, { signal: AbortSignal.timeout(10_000) });
          return { url, ...((await r.json()) as { address: Address; name: string } & Record<string, unknown>) };
        } catch {
          return null;
        }
      }),
    );
    const ok = cards.filter((c): c is NonNullable<typeof c> => c !== null);
    this.sellerCards = ok.map((c) => ({ url: c.url, address: c.address, name: c.name }));
    return { sellers: ok };
  }

  async requestQuote(i: { seller_url: string; service_id: string; rfq_id?: string; counter_offer?: string }): Promise<ToolResult> {
    const s = this.seller(i.seller_url);
    const r = await this.sellerPost(i.seller_url, "/quote", { serviceId: i.service_id, rfqId: i.rfq_id, buyerOffer: i.counter_offer });
    const q = r.quote as Record<string, unknown>;
    const signed: SignedQuote = { ...(q as unknown as SignedQuote), quote: BigInt(q.quote as string) };
    const bad = await checkQuote(signed, s.address);
    if (bad) return { error: `seller quote rejected: ${bad}` };
    this.quotes.set(signed.quoteCommitment, { sellerUrl: i.seller_url, serviceId: i.service_id, rfqId: r.rfqId as string, signed });
    return {
      quote_id: signed.quoteCommitment,
      rfq_id: r.rfqId,
      price: this.fmt(signed.quote),
      calls: signed.calls,
      seller_message: r.message,
    };
  }

  /** Every seller quote goes to the Vault. The agent only learns accept / counter(offer) / walk. */
  async propose(i: { quote_id: string }): Promise<ToolResult> {
    const q = this.quotes.get(i.quote_id);
    if (!q) return { error: "unknown quote_id" };
    const s = this.seller(q.sellerUrl);
    const key = `${q.sellerUrl}|${q.serviceId}|${q.rfqId}`;
    let negotiationId = this.negotiations.get(key);
    if (!negotiationId) {
      const item = CATALOG.find((c) => c.id === q.serviceId);
      if (!item) return { error: "unknown service" };
      const st = await this.cfg.vault.start({ seller: s.address, category: categoryId(item.category), serviceId: q.serviceId });
      if (st.status !== "open") return { decision: "walk" };
      negotiationId = st.negotiationId;
      this.negotiations.set(key, negotiationId);
    }
    try {
      const d = await this.cfg.vault.propose(negotiationId, q.signed);
      if (d.decision === "accept") this.accepted.set(i.quote_id, negotiationId);
      if (d.decision === "counter") return { decision: "counter", counter_offer: d.offer, counter_offer_display: this.fmt(BigInt(d.offer)), rfq_id: q.rfqId };
      return { decision: d.decision };
    } catch (e) {
      if (e instanceof VaultCallError) return { decision: "walk" };
      throw e;
    }
  }

  /**
   * Accepted quote -> seller's cart -> Vault proof -> SessionEscrow.open -> HSP order (cart mandate)
   * -> read the cart back and check it -> EIP-3009 authorization in an HSP payment mandate -> wait
   * until the coordinator marks the session funded.
   */
  async openSession(i: { quote_id: string }): Promise<ToolResult> {
    const negotiationId = this.accepted.get(i.quote_id);
    const q = this.quotes.get(i.quote_id);
    if (!negotiationId || !q) return { error: "quote was not accepted by the vault" };
    const { cart } = (await this.sellerPost(q.sellerUrl, "/cart", { quoteCommitment: i.quote_id })) as { cart: DealCart };

    let proof;
    try {
      proof = await this.cfg.vault.proveSpend(negotiationId, cart);
    } catch (e) {
      return { error: `vault refused to prove this deal: ${(e as Error).message}`, funds_moved: false };
    }

    const hash = await this.walletClient.writeContract({
      address: this.cfg.deployment.escrow,
      abi: sessionEscrowAbi,
      functionName: "open",
      args: openSessionArgs(proof),
      chain: this.walletClient.chain,
      account: this.cfg.wallet,
    });
    const rc = await this.pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") return { error: "SessionEscrow.open reverted", tx: hash, funds_moved: false };
    const sessionId = proof.sessionId;
    const amount = BigInt(proof.amount);
    this.sessions.set(sessionId.toLowerCase(), { sessionId, sellerUrl: q.sellerUrl, serviceId: q.serviceId, calls: proof.calls, unitPrice: amount / BigInt(proof.calls), used: 0 });

    const order = (await this.sellerPost(q.sellerUrl, "/hsp/order", { sessionId })) as { flowId?: string };
    if (!order.flowId) return { error: "seller returned no HSP order", session_id: sessionId, funds_moved: false };
    if (this.mcp) {
      // the flow must be the order our own coordinator made for this session, not one the seller picked
      const mine = (await fetch(`${this.cfg.coordinatorUrl}/hsp/orders/${sessionId}`).then((r) => r.json()).catch(() => ({}))) as { flowId?: string };
      if (!mine.flowId || mine.flowId !== order.flowId) return { error: "refused to pay: the seller's HSP order is not the coordinator's order for this session", session_id: sessionId, funds_moved: false };
      try {
        // prepare -> check the exact authorization (escrow payee, amount = cap, no fees) -> sign -> finalize -> submit
        await this.mcp.pay(order.flowId, this.cfg.wallet, { chainId: this.cfg.chainId, token: this.cfg.deployment.token, escrow: this.cfg.deployment.escrow, amount, maxValiditySeconds: 1800 });
      } catch (e) {
        const msg = (e as Error).message;
        return { error: `HSP payment failed: ${msg}`, session_id: sessionId, funds_moved: msg.startsWith("refused to sign") ? false : "unknown, query the order before retrying" };
      }
      return this.waitFunded(sessionId, amount, proof.calls, hash);
    }
    const hspCart = await this.hsp.cartByFlow(order.flowId);
    const bad = checkCartForSession(hspCart, {
      chainId: this.cfg.chainId,
      token: this.cfg.deployment.token,
      escrow: this.cfg.deployment.escrow,
      amount,
      decimals: this.decimals,
      sessionId,
      x402Method: this.cfg.hsp.x402Method,
    });
    if (bad) return { error: `refused to pay HSP cart: ${bad}`, session_id: sessionId, funds_moved: false };

    const block = await this.pub.getBlock();
    const pm = await buildPaymentMandate({
      cfg: this.cfg.hsp,
      cart: hspCart,
      payer: this.cfg.wallet,
      chainId: this.cfg.chainId,
      tokenDomain: await readTokenDomain(this.pub, this.cfg.deployment.token),
      sessionId,
      amount,
      validBefore: block.timestamp + 600n,
    });
    await this.hsp.payMandate(order.flowId, pm);
    return this.waitFunded(sessionId, amount, proof.calls, hash);
  }

  private async waitFunded(sessionId: Hex, amount: bigint, calls: number, openTx: Hex): Promise<ToolResult> {
    const deadline = Date.now() + (this.cfg.fundingTimeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      const s = await this.pub.readContract({ address: this.cfg.deployment.escrow, abi: sessionEscrowAbi, functionName: "getSession", args: [sessionId] });
      if (s.status === 2) return { session_id: sessionId, status: "funded", calls, price_per_call: this.fmt(amount / BigInt(calls)), open_tx: openTx };
      await new Promise((r) => setTimeout(r, 500));
    }
    return { error: "session not funded in time", session_id: sessionId };
  }

  /** One paid call: get the pre-committed hash, fetch the body, check it, and only then pay with a voucher. */
  async callService(i: { session_id: string }): Promise<ToolResult> {
    const s = this.sessions.get(i.session_id.toLowerCase());
    if (!s) return { error: "unknown session" };
    if (s.used >= s.calls) return { error: "all calls used" };
    const url = `${s.sellerUrl}/service/${s.serviceId}`;
    const headers = { "x-sealed-session": s.sessionId };
    const pre = await fetch(url, { headers });
    if (pre.status !== 402) return { error: `seller did not offer a call (HTTP ${pre.status})` };
    const committedHash = pre.headers.get("x-delivery-hash") ?? "";
    const callId = pre.headers.get("x-call-id") ?? "";
    const price = BigInt(pre.headers.get("x-price") ?? "0");
    if (price !== s.unitPrice) return { error: `seller asked ${price} per call, agreed ${s.unitPrice}`, paid: false };

    const t0 = Date.now();
    const res = await fetch(url, { headers: { ...headers, "x-sealed-call": callId }, signal: AbortSignal.timeout(this.cfg.deliveryTimeoutMs ?? 15_000) });
    const body = await res.text();
    const check = checkDelivery({
      serviceId: s.serviceId,
      body,
      committedHash,
      latencyMs: Date.now() - t0,
      timeoutMs: this.cfg.deliveryTimeoutMs ?? 15_000,
      sessionId: s.sessionId,
      expectedCall: s.used + 1,
      chainId: this.cfg.chainId,
    });
    s.lastCheck = check;
    if (!check.ok) return { delivered: true, check, paid: false };

    const signed = await this.cfg.vault.signVoucher(s.sessionId, committedHash, s.unitPrice.toString());
    await this.sellerPost(s.sellerUrl, "/voucher", signed);
    s.used += 1;
    const data = JSON.parse(body).data;
    return { call: s.used, of: s.calls, check, paid: true, paid_so_far: this.fmt(BigInt(signed.voucher.cumulativeAmount)), data_preview: JSON.stringify(data).slice(0, 400) };
  }

  checkLastDelivery(i: { session_id: string }): ToolResult {
    const s = this.sessions.get(i.session_id.toLowerCase());
    return s?.lastCheck ? { ...s.lastCheck } : { error: "no delivery yet" };
  }

  /** Asks the seller to claim the latest voucher; the escrow refunds the rest. Returns the receipt. */
  async closeSession(i: { session_id: string }): Promise<ToolResult> {
    const s = this.sessions.get(i.session_id.toLowerCase());
    if (!s) return { error: "unknown session" };
    const onchain = await this.pub.readContract({ address: this.cfg.deployment.escrow, abi: sessionEscrowAbi, functionName: "getSession", args: [s.sessionId] });
    if (onchain.status === 2) {
      if (s.used === 0) return { error: "no calls made; the escrow refunds everything after the deadline (closeAfterDeadline)", deadline: onchain.deadline.toString() };
      await this.sellerPost(s.sellerUrl, "/close", { sessionId: s.sessionId });
    }
    // the close transaction may not be visible on every RPC node yet: retry for a few seconds
    for (let i = 0; i < 15; i++) {
      const r = await fetch(`${this.cfg.coordinatorUrl}/receipts/${s.sessionId}`);
      const receipt = (await r.json()) as Record<string, unknown>;
      if (r.ok) return { receipt };
      if (r.status !== 404) return { error: "receipt lookup failed", detail: receipt };
      await new Promise((res) => setTimeout(res, 2_000));
    }
    return { error: "no receipt yet" };
  }

  /** For tests: whether a seller address belongs to a discovered card. */
  knowsSeller(a: Address) {
    return this.sellerCards.some((c) => isAddressEqual(c.address, a));
  }
}
