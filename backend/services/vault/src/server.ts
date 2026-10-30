import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { type Address, type Hex, isAddress, isHex } from "viem";
import { type DealCart, type SignedQuote } from "@sealed/core";
import { verifySpend } from "@sealed/prover";
import { type Vault, VaultError } from "./vault.ts";

export type Role = "admin" | "agent";

/**
 * Routes the buyer agent may call. The agent token works only for these; mandate routes need the
 * admin (user) token. This is the code-level guarantee that the LLM side can never read or set
 * mandate values.
 */
export const AGENT_ROUTES = ["/negotiation/start", "/negotiation/propose", "/proof/spend", "/voucher/sign"] as const;

const addr = z.string().refine((s) => isAddress(s, { strict: false }), "address");
const hex32 = z.string().refine((s) => isHex(s) && s.length === 66, "bytes32");
const uint = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform((v) => BigInt(v));

const SealBody = z.object({
  maxAmount: uint,
  perDealCap: uint,
  categories: z.array(z.number().int().positive()).min(1).max(16),
  sellers: z.array(addr).min(1).max(16),
  expiry: uint,
});
const StartBody = z.object({ seller: addr, category: z.number().int().positive(), serviceId: z.string().min(1).max(64) }).strict();
const QuoteSchema = z
  .object({
    serviceId: z.string().min(1).max(64),
    quote: uint,
    calls: z.number().int().positive().max(1000),
    sellerNonce: hex32,
    quoteCommitment: hex32,
    sellerSignature: z.string().refine((s) => isHex(s), "hex"),
    seller: addr,
  })
  .strict();
const ProposeBody = z.object({ negotiationId: z.string().uuid(), quote: QuoteSchema }).strict();
const CartSchema = z
  .object({
    v: z.literal(1),
    chainId: z.number().int(),
    escrow: addr,
    token: addr,
    seller: addr,
    serviceId: z.string(),
    category: z.number().int(),
    calls: z.number().int().positive(),
    amount: z.string().regex(/^\d+$/),
    quoteCommitment: hex32,
  })
  .strict();
const ProofBody = z.object({ negotiationId: z.string().uuid(), cart: CartSchema }).strict();
const VoucherBody = z.object({ sessionId: hex32, deliveryHash: hex32, price: uint }).strict();

// Agent-facing responses: strict, so an accidental extra field fails loudly instead of leaking.
const StartResponse = z.union([z.object({ status: z.literal("open"), negotiationId: z.string() }).strict(), z.object({ status: z.literal("declined") }).strict()]);
const ProposeResponse = z.union([
  z.object({ decision: z.enum(["accept", "walk"]) }).strict(),
  z.object({ decision: z.literal("counter"), offer: z.string().regex(/^\d+$/) }).strict(),
]);
const ProofResponse = z
  .object({
    sessionId: hex32,
    deadline: z.string(),
    buyer: addr,
    seller: addr,
    cartHash: hex32,
    amount: z.string(),
    calls: z.number(),
    proof: z.object({ a: z.array(z.string()), b: z.array(z.array(z.string())), c: z.array(z.string()), pubSignals: z.array(z.string()).length(12) }).strict(),
  })
  .strict();
const VoucherResponse = z
  .object({
    voucher: z.object({ sessionId: hex32, cumulativeAmount: z.string(), callCount: z.number(), deliveryHashChain: hex32 }).strict(),
    signature: z.string(),
  })
  .strict();

function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface VaultServerOptions {
  adminToken: string;
  agentToken: string;
  responseDelayMs: number;
  logger?: boolean;
}

export function buildVaultServer(vault: Vault, o: VaultServerOptions): FastifyInstance {
  if (!o.adminToken || !o.agentToken || o.adminToken === o.agentToken) throw new Error("vault needs distinct admin and agent tokens");
  const app = Fastify({ logger: o.logger ?? false });

  const roleOf = (req: FastifyRequest): Role | null => {
    const h = req.headers.authorization?.replace(/^Bearer /, "");
    if (tokenMatches(h, o.adminToken)) return "admin";
    if (tokenMatches(h, o.agentToken)) return "agent";
    return null;
  };

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health") return;
    const role = roleOf(req);
    const path = req.url.split("?")[0]!;
    const agentRoute = (AGENT_ROUTES as readonly string[]).includes(path);
    if (role === null) return reply.code(401).send({ error: "unauthorized" });
    if (role === "agent" && !agentRoute) return reply.code(403).send({ error: "forbidden" });
    if (role === "admin" && agentRoute) return reply.code(403).send({ error: "forbidden" });
  });

  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof VaultError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "invalid request" });
    app.log.error(err);
    if (process.env.VAULT_DEBUG) console.error(err);
    return reply.code(500).send({ error: "internal error" });
  });

  /** Fixed response time for negotiation calls, so timing reveals nothing (F4). */
  const fixedDelay = async <T>(fn: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      const left = o.responseDelayMs - (Date.now() - started);
      if (left > 0) await new Promise((r) => setTimeout(r, left));
    }
  };

  app.get("/health", async () => ({ ok: true }));

  // ---- admin (user)

  app.post("/mandate/seal", async (req) => {
    const b = SealBody.parse(req.body);
    const r = await vault.seal({ ...b, sellers: b.sellers as Address[] });
    return r;
  });
  app.post("/mandate/revoke", async () => vault.revoke());
  app.post("/mandate/rotate", async () => vault.rotate());
  app.get("/mandate/status", async () => vault.status());
  app.get("/traces", async () => vault.traces());
  app.get("/meta", async () => vault.meta());
  app.get("/proofs", async () => vault.proofs());
  // anyone can check a Groth16 proof against the verification key; this is the same check SpendVerifier does on chain
  app.post("/circuit/verify", async (req) => {
    const b = z.object({ proof: z.object({ pi_a: z.array(z.string()), pi_b: z.array(z.array(z.string())), pi_c: z.array(z.string()) }).passthrough(), publicSignals: z.array(z.string()).length(12) }).parse(req.body);
    return { valid: await verifySpend(b.proof as never, b.publicSignals).catch(() => false) };
  });

  // ---- agent (buyer LLM tools)

  app.post("/negotiation/start", async (req) => {
    const b = StartBody.parse(req.body);
    return fixedDelay(async () => StartResponse.parse(await vault.startNegotiation({ seller: b.seller as Address, category: b.category, serviceId: b.serviceId })));
  });

  app.post("/negotiation/propose", async (req, reply: FastifyReply) => {
    const b = ProposeBody.parse(req.body);
    return fixedDelay(async () => {
      try {
        return ProposeResponse.parse(await vault.propose(b.negotiationId, b.quote as unknown as SignedQuote));
      } catch (e) {
        if (e instanceof VaultError) return reply.code(e.status).send({ error: e.message });
        throw e;
      }
    });
  });

  app.post("/proof/spend", async (req) => {
    const b = ProofBody.parse(req.body);
    return ProofResponse.parse(await vault.proveSpend(b.negotiationId, b.cart as DealCart));
  });

  app.post("/voucher/sign", async (req) => {
    const b = VoucherBody.parse(req.body);
    return VoucherResponse.parse(await vault.signVoucher(b.sessionId as Hex, b.deliveryHash as Hex, b.price));
  });

  return app;
}
