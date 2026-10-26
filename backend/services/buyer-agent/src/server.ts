import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { BuyerTools, type BuyerToolsConfig } from "./tools.ts";
import { runLlmAgent } from "./llm.ts";
import { runScripted } from "./scripted.ts";

const RunBody = z.union([
  z.object({ mode: z.literal("llm"), task: z.string().min(1).max(4000) }).strict(),
  z.object({ mode: z.literal("scripted"), sellerUrl: z.string().url(), serviceId: z.string(), calls: z.number().int().positive().max(100) }).strict(),
]);

export function buildBuyerServer(toolsConfig: BuyerToolsConfig, o: { llmApiKey?: string; logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: o.logger ?? false });
  const runs = new Map<string, unknown>();

  app.get("/health", async () => ({ ok: true }));

  app.post("/run", async (req) => {
    const b = RunBody.parse(req.body);
    const tools = new BuyerTools(toolsConfig);
    const id = `run-${runs.size + 1}`;
    if (b.mode === "llm") {
      const r = await runLlmAgent(tools, b.task, { apiKey: o.llmApiKey });
      runs.set(id, { finalText: r.finalText, transcript: tools.transcript });
      return { id, finalText: r.finalText, stopReason: r.stopReason, toolCalls: tools.transcript.length };
    }
    const r = await runScripted(tools, { sellerUrl: b.sellerUrl, serviceId: b.serviceId, calls: b.calls });
    runs.set(id, { ...r, transcript: tools.transcript });
    return { id, outcome: r.outcome, sessionId: r.sessionId, receipt: r.receipt };
  });

  app.get("/runs/:id", async (req, reply) => runs.get((req.params as { id: string }).id) ?? reply.code(404).send({ error: "unknown run" }));
  return app;
}
