import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { BuyerTools, type BuyerToolsConfig } from "./tools.ts";
import { runAgent, type LlmConfig } from "./agent.ts";
import { runScripted } from "./scripted.ts";

const RunBody = z.union([
  z.object({ mode: z.literal("llm"), task: z.string().min(1).max(4000) }).strict(),
  z.object({ mode: z.literal("scripted"), sellerUrl: z.string().url(), serviceId: z.string(), calls: z.number().int().positive().max(100) }).strict(),
]);

export function buildBuyerServer(toolsConfig: BuyerToolsConfig, o: { llm?: LlmConfig; logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: o.logger ?? false });
  const runs = new Map<string, unknown>();

  app.get("/health", async () => ({ ok: true, llm: o.llm?.provider ?? null }));

  // Runs can take minutes (chain confirmations, LLM rate limits): start in the background, poll GET /runs/:id.
  app.post("/run", async (req) => {
    const b = RunBody.parse(req.body);
    if (b.mode === "llm" && !o.llm) return { error: "no LLM configured (set GEMINI_API_KEY or LLM_PROVIDER)" };
    const tools = new BuyerTools(toolsConfig);
    const id = `run-${runs.size + 1}`;
    runs.set(id, { status: "running", transcript: tools.transcript });
    const work =
      b.mode === "llm"
        ? runAgent(tools, b.task, o.llm!, { log: (m) => app.log.info({ run: id }, m) }).then((r) => ({
            provider: o.llm!.provider,
            finalText: r.finalText,
            stopReason: r.stopReason,
            receipt: (tools.transcript.findLast((t) => t.tool === "close_session")?.output as { receipt?: unknown } | undefined)?.receipt,
          }))
        : runScripted(tools, { sellerUrl: b.sellerUrl, serviceId: b.serviceId, calls: b.calls });
    work.then(
      (r) => runs.set(id, { status: "done", ...r, transcript: tools.transcript }),
      (e) => runs.set(id, { status: "failed", error: (e as Error).message, transcript: tools.transcript }),
    );
    return { id, status: "running" };
  });

  app.get("/runs/:id", async (req, reply) => runs.get((req.params as { id: string }).id) ?? reply.code(404).send({ error: "unknown run" }));
  return app;
}
