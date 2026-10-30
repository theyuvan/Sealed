import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { type Hex, isHex } from "viem";
import { type Coordinator, CoordinatorError } from "./coordinator.ts";

const hex32 = z.string().refine((s) => isHex(s) && s.length === 66, "bytes32");
const OrderBody = z.object({ sessionId: hex32, sellerSignature: z.string().refine((s) => isHex(s)), merchantLabel: z.string().max(64).default("seller") }).strict();

export function buildCoordinatorServer(c: Coordinator, o: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: o.logger ?? false });

  // Keep the raw body: webhook HMACs are over the exact bytes received.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e) {
      done(e as Error);
    }
  });

  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof CoordinatorError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "invalid request" });
    app.log.error(err);
    return reply.code(502).send({ error: err.message });
  });

  app.get("/health", async () => ({ ok: true, hsp: c.cfg.hsp.localStandIn ? "HSP local stand-in" : "HSP" }));

  app.post("/hsp/orders", async (req) => {
    const b = OrderBody.parse(req.body);
    return c.createOrder(b.sessionId as Hex, b.sellerSignature as Hex, b.merchantLabel);
  });

  app.get("/sessions", async () => c.sessions());

  app.get("/hsp/orders/:sessionId", async (req, reply) => {
    const o = c.order((req.params as { sessionId: Hex }).sessionId);
    if (!o) return reply.code(404).send({ error: "no order" });
    return { sessionId: o.session_id, cartMandateId: o.cart_mandate_id, flowId: o.flow_id, status: o.status, hspTx: o.hsp_tx, fundTx: o.fund_tx };
  });

  app.post("/hsp/webhook", async (req, reply) => {
    const header = req.headers[c.cfg.hsp.headers.webhookSignature.toLowerCase()] as string | undefined;
    const r = await c.handleWebhook((req as unknown as { rawBody?: string }).rawBody ?? "", header);
    return reply.code(r.status).send(r.body);
  });

  app.get("/receipts/:sessionId", async (req) => c.receipt((req.params as { sessionId: Hex }).sessionId));

  return app;
}
