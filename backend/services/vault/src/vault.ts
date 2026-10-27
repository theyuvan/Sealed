import { randomUUID } from "node:crypto";
import {
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  isAddressEqual,
  parseEventLogs,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  CATEGORIES,
  DEFAULT_POLICY,
  type DealCart,
  type Deployment,
  type MandateRules,
  type Note,
  type PolicyParams,
  type PolicyState,
  type Rng,
  type SignedQuote,
  VOUCHER_TYPES,
  chainFor,
  checkQuote,
  commitmentOf,
  computeSessionId,
  cryptoRng,
  dealCartHash,
  encryptToAuditor,
  jsonStringify,
  mandateRegistryAbi,
  newSecrets,
  readSession,
  nextDeliveryChain,
  nullifierOf,
  openDb,
  type Db,
  respond,
  revocationKeyOf,
  sameDeal,
  sessionEscrowAbi,
  startPolicy,
  syncRegistryTree,
  toField,
  voucherDomain,
  EMPTY_DELIVERY_CHAIN, rpcTransport } from "@sealed/core";
import { buildSpendWitness, proveSpend, toSolidityProof, verifySpend } from "@sealed/prover";

export interface VaultConfig {
  chainId: number;
  rpcUrl: string;
  deployment: Deployment;
  /** sends seal / revoke transactions */
  account: Account;
  /** wallet that pays HSP; bound into every session id */
  buyer: Address;
  auditorPublicKey: Hex;
  dbPath: string;
  globalProbeLimit: number;
  perSellerNegotiations: number;
  sellerCooldownMs: number;
  responseDelayMs: number;
  sessionSeconds: number;
  autoRotate: boolean;
  policy?: PolicyParams;
  rng?: Rng;
  logsChunk?: bigint;
  /** structured step log (never receives mandate values) */
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export class VaultError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Mandate input from the user (admin only). Amounts are token base units. */
export interface SealInput {
  maxAmount: bigint;
  perDealCap: bigint;
  categories: number[];
  sellers: Address[];
  expiry: bigint;
}

export type AgentDecision = { decision: "accept" | "walk" } | { decision: "counter"; offer: string };

interface PendingSpend {
  nullifier: string;
  newNote: Note;
  sessionId: Hex;
  expiresAt: number;
}

interface MandateRow {
  id: number;
  status: string;
  note_json: string;
  commitment: string;
  pending_json: string | null;
  evaluations: number;
}

interface NegotiationRow {
  id: string;
  mandate_id: number;
  seller: string;
  category: number;
  service_id: string;
  state_json: string;
  status: string;
  accepted_json: string | null;
}

interface SessionRow {
  session_id: string;
  session_key: string;
  cap: string;
  calls: number;
  unit_price: string;
  cumulative: string;
  call_count: number;
  chain: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mandates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL,
  note_json TEXT NOT NULL,
  commitment TEXT NOT NULL,
  pending_json TEXT,
  evaluations INTEGER NOT NULL DEFAULT 0,
  seal_tx TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS seller_stats (
  seller TEXT PRIMARY KEY,
  negotiations INTEGER NOT NULL,
  last_started_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS negotiations (
  id TEXT PRIMARY KEY,
  mandate_id INTEGER NOT NULL,
  seller TEXT NOT NULL,
  category INTEGER NOT NULL,
  service_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  status TEXT NOT NULL,
  accepted_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trace (
  negotiation_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  quote TEXT NOT NULL,
  decision TEXT NOT NULL,
  offer TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  negotiation_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  seller TEXT NOT NULL,
  cap TEXT NOT NULL,
  calls INTEGER NOT NULL,
  unit_price TEXT NOT NULL,
  cumulative TEXT NOT NULL,
  call_count INTEGER NOT NULL,
  chain TEXT NOT NULL,
  deadline INTEGER NOT NULL
);
`;

// ---------------------------------------------------------------- (de)serialisation

function noteFromJson(s: string): Note {
  const j = JSON.parse(s);
  return {
    rules: {
      maxRemaining: BigInt(j.rules.maxRemaining),
      perDealCap: BigInt(j.rules.perDealCap),
      categories: j.rules.categories,
      sellers: j.rules.sellers,
      token: j.rules.token,
      expiry: BigInt(j.rules.expiry),
    },
    secrets: { mandateId: BigInt(j.secrets.mandateId), salt: BigInt(j.secrets.salt), ownerSecret: BigInt(j.secrets.ownerSecret) },
  };
}

function policyFromJson(s: string): PolicyState {
  const j = JSON.parse(s);
  return { ...j, target: BigInt(j.target), lastOffer: BigInt(j.lastOffer) };
}

function pendingFromJson(s: string): PendingSpend {
  const j = JSON.parse(s);
  return { ...j, newNote: noteFromJson(JSON.stringify(j.newNote)) };
}

// ---------------------------------------------------------------- the vault

export class Vault {
  readonly db: Db;
  readonly pub: PublicClient;
  readonly wallet: WalletClient;
  private readonly rng: Rng;
  private readonly policy: PolicyParams;
  private chainLock: Promise<unknown> = Promise.resolve();

  constructor(readonly cfg: VaultConfig) {
    this.db = openDb(cfg.dbPath, SCHEMA);
    const chain = chainFor(cfg.chainId, cfg.rpcUrl);
    this.pub = createPublicClient({ chain, transport: rpcTransport(cfg.rpcUrl) }) as PublicClient;
    this.wallet = createWalletClient({ chain, transport: rpcTransport(cfg.rpcUrl), account: cfg.account });
    this.rng = cfg.rng ?? cryptoRng;
    this.policy = cfg.policy ?? DEFAULT_POLICY;
  }

  /** Serialises chain-touching operations (one pending spend at a time, ordered txs). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chainLock.then(fn, fn);
    this.chainLock = run.catch(() => undefined);
    return run;
  }

  private async chainNow(): Promise<number> {
    const b = await this.pub.getBlock({ blockTag: "latest" });
    return Number(b.timestamp);
  }

  private async send(functionName: "seal" | "revoke", args: readonly unknown[]): Promise<{ hash: Hex; leafIndex?: bigint }> {
    const hash = await this.wallet.writeContract({
      address: this.cfg.deployment.registry,
      abi: mandateRegistryAbi,
      functionName,
      args: args as never,
      chain: this.wallet.chain,
      account: this.cfg.account,
    });
    const r = await this.pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new VaultError(`${functionName} transaction reverted`, 502);
    const sealed = parseEventLogs({ abi: mandateRegistryAbi, logs: r.logs, eventName: "Sealed" })[0];
    return { hash, leafIndex: sealed?.args.leafIndex };
  }

  // ------------------------------------------------------------ mandate (admin only)

  private activeMandate(): MandateRow | undefined {
    return this.db.prepare("SELECT * FROM mandates WHERE status = 'active' ORDER BY id DESC LIMIT 1").get() as unknown as MandateRow | undefined;
  }

  seal(input: SealInput): Promise<{ commitment: string; txHash: Hex; leafIndex: number }> {
    return this.exclusive(async () => {
      if (input.categories.length === 0 || input.sellers.length === 0) throw new VaultError("need at least one category and one seller");
      if (input.perDealCap <= 0n || input.maxAmount <= 0n) throw new VaultError("amounts must be positive");
      if (input.maxAmount >= 2n ** 64n || input.perDealCap >= 2n ** 64n || input.expiry >= 2n ** 64n) throw new VaultError("value exceeds 64 bits");
      const prev = this.activeMandate();
      if (prev) await this.revokeRow(prev, "replaced");
      const rules: MandateRules = {
        maxRemaining: input.maxAmount,
        perDealCap: input.perDealCap,
        categories: input.categories,
        sellers: input.sellers,
        token: this.cfg.deployment.token,
        expiry: input.expiry,
      };
      return this.sealNote({ rules, secrets: newSecrets() });
    });
  }

  private async sealNote(note: Note) {
    const commitment = commitmentOf(note);
    const ciphertext = encryptToAuditor(
      this.cfg.auditorPublicKey,
      jsonStringify({ rules: note.rules, mandateId: note.secrets.mandateId, chainId: this.cfg.chainId }),
    );
    const { hash, leafIndex } = await this.send("seal", [commitment, ciphertext]);
    this.db
      .prepare("INSERT INTO mandates (status, note_json, commitment, evaluations, seal_tx, created_at) VALUES ('active', ?, ?, 0, ?, ?)")
      .run(jsonStringify(note), commitment.toString(), hash, Date.now());
    return { commitment: commitment.toString(), txHash: hash, leafIndex: Number(leafIndex ?? -1) };
  }

  private async revokeRow(row: MandateRow, status: "revoked" | "replaced" | "rotated"): Promise<Hex> {
    const note = noteFromJson(row.note_json);
    const { hash } = await this.send("revoke", [revocationKeyOf(note.secrets)]);
    this.db.prepare("UPDATE mandates SET status = ?, pending_json = NULL WHERE id = ?").run(status, row.id);
    return hash;
  }

  revoke(): Promise<{ txHash: Hex }> {
    return this.exclusive(async () => {
      const row = this.activeMandate();
      if (!row) throw new VaultError("no active mandate", 404);
      return { txHash: await this.revokeRow(row, "revoked") };
    });
  }

  /** New mandateId and secrets, same remaining rules; the old mandate is revoked on chain. */
  rotate(): Promise<{ commitment: string }> {
    return this.exclusive(async () => {
      const row = this.activeMandate();
      if (!row) throw new VaultError("no active mandate", 404);
      await this.refreshNote(row);
      const current = noteFromJson((this.db.prepare("SELECT note_json FROM mandates WHERE id = ?").get(row.id) as { note_json: string }).note_json);
      await this.revokeRow(row, "rotated");
      const r = await this.sealNote({ rules: current.rules, secrets: newSecrets() });
      return { commitment: r.commitment };
    });
  }

  /** Admin view for the user's own UI. Never exposed to the agent. */
  async status() {
    const stale = this.activeMandate();
    if (stale) await this.exclusive(() => this.refreshNote(stale));
    const row = this.activeMandate();
    if (!row) return { active: false as const };
    const note = noteFromJson(row.note_json);
    return {
      active: true as const,
      remaining: note.rules.maxRemaining.toString(),
      perDealCap: note.rules.perDealCap.toString(),
      expiry: note.rules.expiry.toString(),
      evaluations: row.evaluations,
      commitment: row.commitment,
      pendingSpend: row.pending_json !== null,
    };
  }

  /** Advance the stored note once its pending spend has been consumed on chain. */
  private async refreshNote(row: MandateRow): Promise<void> {
    if (!row.pending_json) return;
    const p = pendingFromJson(row.pending_json);
    const spent = await this.pub.readContract({ address: this.cfg.deployment.registry, abi: mandateRegistryAbi, functionName: "isSpent", args: [BigInt(p.nullifier)] });
    if (spent) {
      this.db
        .prepare("UPDATE mandates SET note_json = ?, commitment = ?, pending_json = NULL WHERE id = ?")
        .run(jsonStringify(p.newNote), commitmentOf(p.newNote).toString(), row.id);
    } else if ((await this.chainNow()) > p.expiresAt) {
      this.db.prepare("UPDATE mandates SET pending_json = NULL WHERE id = ?").run(row.id);
    }
  }

  // ------------------------------------------------------------ negotiation (agent)

  async startNegotiation(o: { seller: Address; category: number; serviceId: string }): Promise<{ status: "open"; negotiationId: string } | { status: "declined" }> {
    const declined = { status: "declined" as const };
    const row = this.activeMandate();
    if (!row) return declined;
    await this.exclusive(() => this.refreshNote(row));
    const fresh = this.activeMandate();
    if (!fresh) return declined;
    const note = noteFromJson(fresh.note_json);
    if (BigInt(await this.chainNow()) >= note.rules.expiry) return declined;
    if (!note.rules.sellers.some((s) => isAddressEqual(s, o.seller))) return declined;
    if (!note.rules.categories.includes(o.category)) return declined;
    if (fresh.evaluations >= this.cfg.globalProbeLimit) return declined;

    const sellerKey = o.seller.toLowerCase();
    const stats = this.db.prepare("SELECT * FROM seller_stats WHERE seller = ?").get(sellerKey) as { negotiations: number; last_started_at: number } | undefined;
    if (stats && stats.negotiations >= this.cfg.perSellerNegotiations) return declined;
    if (stats && Date.now() - stats.last_started_at < this.cfg.sellerCooldownMs) return declined;

    const theta = note.rules.maxRemaining < note.rules.perDealCap ? note.rules.maxRemaining : note.rules.perDealCap;
    if (theta <= 0n) return declined;
    const state = startPolicy(theta, this.rng, this.policy);
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO negotiations (id, mandate_id, seller, category, service_id, state_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)")
      .run(id, fresh.id, sellerKey, o.category, o.serviceId, jsonStringify(state), Date.now());
    this.db
      .prepare("INSERT INTO seller_stats (seller, negotiations, last_started_at) VALUES (?, 1, ?) ON CONFLICT(seller) DO UPDATE SET negotiations = negotiations + 1, last_started_at = excluded.last_started_at")
      .run(sellerKey, Date.now());
    return { status: "open", negotiationId: id };
  }

  async propose(negotiationId: string, quote: SignedQuote): Promise<AgentDecision> {
    const n = this.db.prepare("SELECT * FROM negotiations WHERE id = ?").get(negotiationId) as unknown as NegotiationRow | undefined;
    if (!n) throw new VaultError("unknown negotiation", 404);
    if (n.status !== "open") return { decision: "walk" };
    // Quotes must be committed and signed by the seller before they are evaluated (F5).
    if (quote.serviceId !== n.service_id) throw new VaultError("quote rejected");
    if (!Number.isInteger(quote.calls) || quote.calls <= 0 || quote.quote <= 0n || quote.quote % BigInt(quote.calls) !== 0n) throw new VaultError("quote rejected");
    if (await checkQuote(quote, n.seller as Address)) throw new VaultError("quote rejected");

    const m = this.db.prepare("SELECT * FROM mandates WHERE id = ?").get(n.mandate_id) as unknown as MandateRow;
    if (m.status !== "active") return this.close(n, "walk");
    if (m.evaluations >= this.cfg.globalProbeLimit) {
      if (this.cfg.autoRotate) await this.rotate().catch(() => undefined);
      return this.close(n, "walk");
    }
    this.db.prepare("UPDATE mandates SET evaluations = evaluations + 1 WHERE id = ?").run(m.id);

    const state = policyFromJson(n.state_json);
    const d = respond(state, quote.quote, this.rng, this.policy);
    this.db.prepare("UPDATE negotiations SET state_json = ? WHERE id = ?").run(jsonStringify(state), n.id);
    this.db
      .prepare("INSERT INTO trace (negotiation_id, round, quote, decision, offer, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(n.id, state.round, quote.quote.toString(), d.decision, d.offer?.toString() ?? null, Date.now());

    if (d.decision === "accept") {
      this.db.prepare("UPDATE negotiations SET status = 'accepted', accepted_json = ? WHERE id = ?").run(jsonStringify(quote), n.id);
      return { decision: "accept" };
    }
    if (d.decision === "walk") return this.close(n, "walk");
    return { decision: "counter", offer: d.offer.toString() };
  }

  private close(n: NegotiationRow, decision: "walk"): AgentDecision {
    this.db.prepare("UPDATE negotiations SET status = 'walked' WHERE id = ?").run(n.id);
    return { decision };
  }

  /** The cart the Vault will prove for an accepted negotiation. */
  expectedCart(negotiationId: string): DealCart {
    const n = this.db.prepare("SELECT * FROM negotiations WHERE id = ?").get(negotiationId) as unknown as NegotiationRow | undefined;
    if (!n || (n.status !== "accepted" && n.status !== "proved") || !n.accepted_json) throw new VaultError("negotiation not accepted");
    const q = JSON.parse(n.accepted_json);
    return {
      v: 1,
      chainId: this.cfg.chainId,
      escrow: this.cfg.deployment.escrow,
      token: this.cfg.deployment.token,
      seller: n.seller as Address,
      serviceId: n.service_id,
      category: n.category,
      calls: q.calls,
      amount: String(q.quote),
      quoteCommitment: q.quoteCommitment,
    };
  }

  // ------------------------------------------------------------ proof (agent)

  proveSpend(negotiationId: string, cart: DealCart) {
    return this.exclusive(async () => {
      const n = this.db.prepare("SELECT * FROM negotiations WHERE id = ?").get(negotiationId) as unknown as NegotiationRow | undefined;
      if (!n || n.status !== "accepted") throw new VaultError("negotiation not accepted");
      const expected = this.expectedCart(negotiationId);
      if (!sameDeal(cart, expected)) throw new VaultError("cart does not match the accepted deal");

      const m = this.db.prepare("SELECT * FROM mandates WHERE id = ?").get(n.mandate_id) as unknown as MandateRow;
      if (m.status !== "active") throw new VaultError("mandate no longer active");
      const step = (s: string) => this.cfg.log?.(`proof: ${s}`, { negotiationId });
      step("refresh note");
      await this.refreshNote(m);
      const row = this.db.prepare("SELECT * FROM mandates WHERE id = ?").get(m.id) as unknown as MandateRow;
      if (row.pending_json) throw new VaultError("another spend is pending", 409);
      const note = noteFromJson(row.note_json);

      step("sync registry tree");
      const tree = await syncRegistryTree(this.pub, this.cfg.deployment.registry, BigInt(this.cfg.deployment.deployBlock), this.cfg.logsChunk);
      step(`tree synced (${tree.leaves.length} leaves), reading chain time`);
      const now = await this.chainNow();
      const amount = BigInt(expected.amount);
      const sessionKey = generatePrivateKey();
      const sessionAddr = privateKeyToAccount(sessionKey).address;
      const deadline = BigInt(now + this.cfg.sessionSeconds);
      const nullifier = nullifierOf(note);
      const sessionId = computeSessionId({ chainId: this.cfg.chainId, escrow: this.cfg.deployment.escrow, nullifier, buyer: this.cfg.buyer, seller: expected.seller, deadline });
      const cartHash = dealCartHash(expected);

      const w = buildSpendWitness({
        note,
        tree,
        amount,
        category: expected.category,
        seller: expected.seller,
        cartHash: toField(cartHash),
        sessionId: toField(sessionId),
        sessionKeyHash: BigInt(sessionAddr),
        now: BigInt(now),
      });
      let proof;
      step("generating Groth16 proof");
      try {
        proof = await proveSpend(w.input);
      } catch {
        // The circuit refused: the deal does not fit the mandate. No reason is given.
        throw new VaultError("deal rejected");
      }
      if (!(await verifySpend(proof.proof, proof.publicSignals))) throw new VaultError("deal rejected");
      step("proof generated and verified");
      const sol = toSolidityProof(proof.proof, proof.publicSignals);

      const pending: PendingSpend = { nullifier: nullifier.toString(), newNote: w.newNote, sessionId, expiresAt: now + 360 };
      this.db.prepare("UPDATE mandates SET pending_json = ? WHERE id = ?").run(jsonStringify(pending), row.id);
      this.db.prepare("UPDATE negotiations SET status = 'proved' WHERE id = ?").run(n.id);
      this.db
        .prepare(
          "INSERT INTO sessions (session_id, negotiation_id, session_key, seller, cap, calls, unit_price, cumulative, call_count, chain, deadline) VALUES (?, ?, ?, ?, ?, ?, ?, '0', 0, ?, ?)",
        )
        .run(sessionId, n.id, sessionKey, expected.seller, amount.toString(), expected.calls, (amount / BigInt(expected.calls)).toString(), EMPTY_DELIVERY_CHAIN, Number(deadline));

      return {
        sessionId,
        deadline: deadline.toString(),
        buyer: this.cfg.buyer,
        seller: expected.seller,
        cartHash,
        amount: amount.toString(),
        calls: expected.calls,
        proof: {
          a: sol.a.map(String),
          b: sol.b.map((r) => r.map(String)),
          c: sol.c.map(String),
          pubSignals: sol.pubSignals.map(String),
        },
      };
    });
  }

  // ------------------------------------------------------------ vouchers (agent)

  async signVoucher(sessionId: Hex, deliveryHash: Hex, price: bigint) {
    const s = this.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as unknown as SessionRow | undefined;
    if (!s) throw new VaultError("unknown session", 404);
    const onchain = await readSession(this.pub, this.cfg.deployment.escrow, sessionId, (x) => x.status >= 2, 15_000);
    if (onchain.status !== 2) throw new VaultError("session is not funded");
    if (price !== BigInt(s.unit_price)) throw new VaultError("price does not match the agreed per-call price");
    if (s.call_count + 1 > s.calls) throw new VaultError("all calls already paid");
    const cumulative = BigInt(s.cumulative) + price;
    if (cumulative > BigInt(s.cap)) throw new VaultError("over session cap");

    const chain = nextDeliveryChain(s.chain as Hex, deliveryHash);
    const voucher = { sessionId, cumulativeAmount: cumulative, callCount: s.call_count + 1, deliveryHashChain: chain };
    const signer = privateKeyToAccount(s.session_key as Hex);
    const signature = await signer.signTypedData({ domain: voucherDomain(this.cfg.chainId, this.cfg.deployment.escrow), types: VOUCHER_TYPES, primaryType: "Voucher", message: voucher });
    this.db.prepare("UPDATE sessions SET cumulative = ?, call_count = ?, chain = ? WHERE session_id = ?").run(cumulative.toString(), voucher.callCount, chain, sessionId);
    return {
      voucher: { sessionId, cumulativeAmount: cumulative.toString(), callCount: voucher.callCount, deliveryHashChain: chain },
      signature,
    };
  }

  /** Negotiation traces for the adversary evaluator (quotes and offers only, no mandate values). */
  traces(): { negotiationId: string; round: number; quote: string; decision: string; offer: string | null }[] {
    return this.db.prepare("SELECT negotiation_id AS negotiationId, round, quote, decision, offer FROM trace ORDER BY negotiation_id, round").all() as never;
  }
}

export { CATEGORIES };
