import {
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  isAddressEqual,
  keccak256,
  parseEventLogs,
  recoverMessageAddress,
  stringToHex,
} from "viem";
import {
  type Deployment,
  type HspConfig,
  type HspPaymentRecord,
  HspClient,
  buildSessionCartContents,
  chainFor,
  eip3009Abi,
  decimalToUnits,
  explorerTx,
  hspStatusClass,
  merchantAuthorization,
  readSession,
  openDb,
  type Db,
  sessionCartMandateId,
  sessionEscrowAbi,
  sessionPaymentRequestId,
  unitsToDecimal,
  validateCartContents,
  verifyWebhook, rpcTransport } from "@sealed/core";

export interface CoordinatorConfig {
  chainId: number;
  rpcUrl: string;
  deployment: Deployment;
  account: Account;
  hsp: HspConfig;
  decimals: number;
  dbPath: string;
  cartTtlSeconds?: number;
  logsChunk?: bigint;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export class CoordinatorError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

interface OrderRow {
  session_id: string;
  seller: string;
  cart_mandate_id: string;
  payment_request_id: string;
  flow_id: string | null;
  payment_url: string | null;
  hsp_order_id: string;
  amount: string;
  status: string;
  hsp_tx: string | null;
  fund_tx: string | null;
  from_block: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  session_id TEXT PRIMARY KEY,
  seller TEXT NOT NULL,
  cart_mandate_id TEXT NOT NULL,
  payment_request_id TEXT NOT NULL,
  flow_id TEXT,
  payment_url TEXT,
  hsp_order_id TEXT NOT NULL,
  amount TEXT NOT NULL,
  status TEXT NOT NULL,
  hsp_tx TEXT,
  fund_tx TEXT,
  from_block TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_events (event_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
`;

/** Message a seller signs to ask for the HSP order of its session. */
export function orderRequestMessage(sessionId: Hex): Hex {
  return keccak256(stringToHex(`sealed.hsp.order:${sessionId.toLowerCase()}`));
}

/**
 * Settlement coordinator: the HSP merchant for sealed sessions. Creates the HSP order (AP2 cart
 * mandate, payee = SessionEscrow, total = session cap), receives HSP webhooks, polls HSP, and calls
 * SessionEscrow.markFunded only when HSP, the chain and the escrow balance all agree.
 */
export class Coordinator {
  readonly db: Db;
  readonly pub: PublicClient;
  readonly wallet: WalletClient;
  readonly hsp: HspClient;
  private confirming = new Map<string, Promise<unknown>>();

  constructor(readonly cfg: CoordinatorConfig) {
    this.db = openDb(cfg.dbPath, SCHEMA);
    const chain = chainFor(cfg.chainId, cfg.rpcUrl);
    this.pub = createPublicClient({ chain, transport: rpcTransport(cfg.rpcUrl) }) as PublicClient;
    this.wallet = createWalletClient({ chain, transport: rpcTransport(cfg.rpcUrl), account: cfg.account });
    this.hsp = new HspClient(cfg.hsp);
  }

  private log(msg: string, data?: Record<string, unknown>) {
    this.cfg.log?.(msg, data);
  }

  /** Session as the chain sees it; re-read briefly so a lagging RPC node does not hide a just-opened session. */
  private session(sessionId: Hex) {
    return readSession(this.pub, this.cfg.deployment.escrow, sessionId);
  }

  order(sessionId: Hex): OrderRow | undefined {
    return this.db.prepare("SELECT * FROM orders WHERE session_id = ?").get(sessionId.toLowerCase()) as OrderRow | undefined;
  }

  // ------------------------------------------------------------ order creation (seller asks)

  async createOrder(sessionId: Hex, sellerSignature: Hex, merchantLabel: string) {
    const s = await this.session(sessionId);
    if (s.status !== 1) throw new CoordinatorError("session is not open");
    const signer = await recoverMessageAddress({ message: { raw: orderRequestMessage(sessionId) }, signature: sellerSignature }).catch(() => null);
    if (!signer || !isAddressEqual(signer, s.seller)) throw new CoordinatorError("only the session's seller can request its order", 403);

    const existing = this.order(sessionId);
    if (existing && existing.status !== "failed") return this.orderView(existing);

    const attempt = existing ? Number(existing.cart_mandate_id.split("-R")[1] ?? 0) + 1 : 0;
    const cartMandateId = sessionCartMandateId(this.cfg.chainId, sessionId, attempt);
    const paymentRequestId = sessionPaymentRequestId(sessionId, attempt);
    const value = unitsToDecimal(s.cap, this.cfg.decimals);
    const contents = buildSessionCartContents({
      cfg: this.cfg.hsp,
      chainId: this.cfg.chainId,
      token: s.token,
      escrow: this.cfg.deployment.escrow,
      amount: value,
      cartMandateId,
      paymentRequestId,
      label: `Sealed session ${sessionId.slice(0, 10)} (${merchantLabel})`,
      expiresAt: new Date(Date.now() + (this.cfg.cartTtlSeconds ?? 1800) * 1000),
    });
    // HSP answers a malformed cart with 10001 and creates nothing; catch it here with a readable reason
    const problems = validateCartContents(contents, { checkTokens: !this.cfg.hsp.localStandIn });
    if (problems.length) throw new CoordinatorError(`cart rejected before submission: ${problems.join("; ")}`, 500);
    const cart = {
      contents,
      merchant_authorization: merchantAuthorization(contents, { merchantName: this.cfg.hsp.merchantName, audience: this.cfg.hsp.jwtAudience, key: this.hsp.merchantKey }),
    };
    const fromBlock = await this.pub.getBlockNumber({ cacheTime: 0 });
    const r = await this.hsp.createOrder(cart);
    const row: OrderRow = {
      session_id: sessionId.toLowerCase(),
      seller: s.seller,
      cart_mandate_id: cartMandateId,
      payment_request_id: r.payment_request_id ?? paymentRequestId,
      flow_id: r.flow_id ?? flowIdFromUrl(r.payment_url),
      payment_url: r.payment_url ?? null,
      hsp_order_id: keccak256(stringToHex(cartMandateId)),
      amount: s.cap.toString(),
      status: "created",
      hsp_tx: null,
      fund_tx: null,
      from_block: fromBlock.toString(),
    };
    this.db
      .prepare(
        `INSERT INTO orders (session_id, seller, cart_mandate_id, payment_request_id, flow_id, payment_url, hsp_order_id, amount, status, from_block, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET cart_mandate_id = excluded.cart_mandate_id, flow_id = excluded.flow_id, payment_url = excluded.payment_url,
           hsp_order_id = excluded.hsp_order_id, status = excluded.status, from_block = excluded.from_block`,
      )
      .run(row.session_id, row.seller, row.cart_mandate_id, row.payment_request_id, row.flow_id, row.payment_url, row.hsp_order_id, row.amount, row.status, row.from_block, Date.now());
    this.log("hsp order created", { sessionId, cartMandateId, flowId: row.flow_id });
    return this.orderView(row);
  }

  private orderView(o: OrderRow) {
    return { sessionId: o.session_id, cartMandateId: o.cart_mandate_id, paymentRequestId: o.payment_request_id, flowId: o.flow_id, paymentUrl: o.payment_url, hspOrderId: o.hsp_order_id, status: o.status };
  }

  // ------------------------------------------------------------ webhooks + polling

  /** Returns HTTP status + body for the webhook route. */
  async handleWebhook(rawBody: string, signatureHeader: string | undefined): Promise<{ status: number; body: unknown }> {
    const err = verifyWebhook(this.cfg.hsp.webhookSecret, signatureHeader, rawBody);
    if (err) return { status: 401, body: { error: err } };
    let rec: HspPaymentRecord & Record<string, unknown>;
    try {
      rec = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: { error: "invalid json" } };
    }
    const rawEventId = String(rec[this.cfg.hsp.webhookEventIdField] ?? "");
    if (!rawEventId) return { status: 400, body: { error: "missing event id" } };
    // included, safe and finalized events share one request_id, so dedupe per status
    const eventId = `${rawEventId}:${rec.status ?? ""}`;
    const fresh = this.db.prepare("INSERT OR IGNORE INTO webhook_events (event_id, received_at) VALUES (?, ?)").run(eventId, Date.now());
    if (fresh.changes === 0) return { status: 200, body: { ok: true, duplicate: true } };

    const o = this.db.prepare("SELECT * FROM orders WHERE cart_mandate_id = ? OR payment_request_id = ?").get(rec.cart_mandate_id ?? "", rec.payment_request_id ?? "") as OrderRow | undefined;
    if (!o) return { status: 200, body: { ok: true, ignored: "unknown order" } };
    this.log("hsp webhook", { sessionId: o.session_id, status: rec.status, eventId });
    if (hspStatusClass(this.cfg.hsp, rec.status) === "success") void this.confirm(o.session_id as Hex, rec).catch((e) => this.log("confirm failed", { error: (e as Error).message }));
    return { status: 200, body: { ok: true } };
  }

  /** Polls HSP for every unfunded order. Run periodically so a missed webhook never loses a settlement. */
  async pollOnce(): Promise<void> {
    const rows = this.db.prepare("SELECT * FROM orders WHERE status IN ('created', 'paid')").all() as unknown as OrderRow[];
    for (const o of rows) {
      try {
        const records = await this.hsp.payments({ cart_mandate_id: o.cart_mandate_id });
        const rec = records.find((r) => hspStatusClass(this.cfg.hsp, r.status) === "success");
        if (rec) await this.confirm(o.session_id as Hex, rec);
        else if (records.some((r) => hspStatusClass(this.cfg.hsp, r.status) === "failed")) this.db.prepare("UPDATE orders SET status = 'failed' WHERE session_id = ?").run(o.session_id);
      } catch (e) {
        this.log("poll error", { sessionId: o.session_id, error: (e as Error).message });
      }
    }
  }

  /** One confirmation at a time per session. */
  confirm(sessionId: Hex, rec: HspPaymentRecord): Promise<unknown> {
    const key = sessionId.toLowerCase();
    const running = this.confirming.get(key);
    if (running) return running;
    const p = this.doConfirm(sessionId, rec).finally(() => this.confirming.delete(key));
    this.confirming.set(key, p);
    return p;
  }

  private async doConfirm(sessionId: Hex, rec: HspPaymentRecord): Promise<{ funded: boolean; reason?: string }> {
    const o = this.order(sessionId);
    if (!o) return { funded: false, reason: "unknown order" };
    if (o.status === "funded") return { funded: true };
    if (hspStatusClass(this.cfg.hsp, rec.status) !== "success") return { funded: false, reason: "HSP has not reported success" };
    if (rec.cart_mandate_id && rec.cart_mandate_id !== o.cart_mandate_id) return { funded: false, reason: "HSP record is for another order" };
    this.db.prepare("UPDATE orders SET status = 'paid' WHERE session_id = ?").run(o.session_id);

    const s = await this.session(sessionId);
    if (s.status !== 1) return { funded: s.status === 2, reason: `session status ${s.status}` };
    const cap = s.cap;

    // 1b. what HSP says the payer paid must be exactly the cap: no service, network or gas fee on top
    const billed = rec.pay_amount ?? rec.amount;
    if (billed !== undefined) {
      let billedUnits: bigint | null = null;
      try {
        billedUnits = decimalToUnits(String(billed), this.cfg.decimals);
      } catch {
        // falls through to the mismatch below
      }
      if (billedUnits !== cap) return { funded: false, reason: `HSP pay_amount ${billed} differs from the session cap (fees added?)` };
    }

    // 2. the exact EIP-3009 transfer is on chain: buyer -> escrow, value = cap, nonce = sessionId
    const used = await this.pub.readContract({ address: s.token, abi: eip3009Abi, functionName: "authorizationState", args: [s.buyer, sessionId] });
    if (!used) return { funded: false, reason: "authorization not used on chain yet" };
    const txHash = await this.findTransferTx(sessionId, s.token, s.buyer, BigInt(o.from_block), rec.tx_signature as Hex | undefined);
    if (!txHash) return { funded: false, reason: "transfer not found yet" };
    const rc = await this.pub.getTransactionReceipt({ hash: txHash });
    const logs = parseEventLogs({ abi: eip3009Abi, logs: rc.logs.filter((l) => isAddressEqual(l.address, s.token)) });
    const auth = logs.find((l) => l.eventName === "AuthorizationUsed" && isAddressEqual(l.args.authorizer as Address, s.buyer) && l.args.nonce === sessionId);
    const transfer = logs.find(
      (l) => l.eventName === "Transfer" && isAddressEqual(l.args.from as Address, s.buyer) && isAddressEqual(l.args.to as Address, this.cfg.deployment.escrow) && l.args.value === cap,
    );
    if (!auth || !transfer) return { funded: false, reason: "transaction is not the exact session transfer" };

    // 3. escrow balance covers every funded session plus this one
    const [balance, locked] = await Promise.all([
      this.pub.readContract({ address: s.token, abi: eip3009Abi, functionName: "balanceOf", args: [this.cfg.deployment.escrow] }),
      this.pub.readContract({ address: this.cfg.deployment.escrow, abi: sessionEscrowAbi, functionName: "locked", args: [s.token] }),
    ]);
    if (balance < locked + cap) return { funded: false, reason: "escrow balance check failed" };

    const fundTx = await this.wallet.writeContract({
      address: this.cfg.deployment.escrow,
      abi: sessionEscrowAbi,
      functionName: "markFunded",
      args: [sessionId, o.hsp_order_id as Hex],
      chain: this.wallet.chain,
      account: this.cfg.account,
    });
    const frc = await this.pub.waitForTransactionReceipt({ hash: fundTx });
    if (frc.status !== "success") return { funded: false, reason: "markFunded reverted" };
    this.db.prepare("UPDATE orders SET status = 'funded', hsp_tx = ?, fund_tx = ? WHERE session_id = ?").run(txHash, fundTx, o.session_id);
    this.log("session funded", { sessionId, hspTx: txHash, fundTx });
    return { funded: true };
  }

  private async findTransferTx(sessionId: Hex, token: Address, buyer: Address, fromBlock: bigint, hinted?: Hex): Promise<Hex | null> {
    if (hinted && /^0x[0-9a-fA-F]{64}$/.test(hinted)) return hinted;
    const latest = await this.pub.getBlockNumber({ cacheTime: 0 });
    const chunk = this.cfg.logsChunk ?? 5_000n;
    for (let start = fromBlock; start <= latest; start += chunk) {
      const end = start + chunk - 1n > latest ? latest : start + chunk - 1n;
      const logs = await this.pub.getContractEvents({ address: token, abi: eip3009Abi, eventName: "AuthorizationUsed", args: { authorizer: buyer, nonce: sessionId }, fromBlock: start, toBlock: end });
      if (logs[0]) return logs[0].transactionHash;
    }
    return null;
  }

  // ------------------------------------------------------------ receipts

  async receipt(sessionId: Hex) {
    const fromBlock = BigInt(this.cfg.deployment.deployBlock);
    const latest = await this.pub.getBlockNumber({ cacheTime: 0 });
    const chunk = this.cfg.logsChunk ?? 5_000n;
    const find = async (eventName: "SessionOpened" | "SessionFunded" | "Receipt") => {
      for (let start = fromBlock; start <= latest; start += chunk) {
        const end = start + chunk - 1n > latest ? latest : start + chunk - 1n;
        const logs = await this.pub.getContractEvents({ address: this.cfg.deployment.escrow, abi: sessionEscrowAbi, eventName, args: { sessionId }, fromBlock: start, toBlock: end });
        if (logs[0]) return logs[0];
      }
      return null;
    };
    const [opened, funded, closed] = await Promise.all([find("SessionOpened"), find("SessionFunded"), find("Receipt")]);
    if (!closed) throw new CoordinatorError("no receipt yet", 404);
    const r = closed.args as { nullifier: bigint; hspOrderId: Hex; paid: bigint; refunded: bigint; deliveryHashChain: Hex };
    const o = this.order(sessionId);
    const link = (tx?: string | null) => (tx ? { tx, explorer: explorerTx(this.cfg.chainId, tx) } : null);
    return {
      sessionId,
      nullifier: r.nullifier.toString(),
      hspOrderId: r.hspOrderId,
      hspCartMandateId: o?.cart_mandate_id ?? null,
      hspPaymentRequestId: o?.payment_request_id ?? null,
      paid: r.paid.toString(),
      refunded: r.refunded.toString(),
      deliveryHashChain: r.deliveryHashChain,
      txs: {
        open: link(opened?.transactionHash),
        hspTransfer: link(o?.hsp_tx),
        markFunded: link(funded?.transactionHash ?? o?.fund_tx),
        close: link(closed.transactionHash),
      },
      hspMode: this.cfg.hsp.localStandIn ? "HSP local stand-in" : "HSP",
    };
  }
}

function flowIdFromUrl(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? null;
  } catch {
    return null;
  }
}
