import { runLlmAgent } from "./llm.ts";
import { runGeminiAgent } from "./llm-gemini.ts";
import type { BuyerTools } from "./tools.ts";

export type LlmConfig = { provider: "gemini"; apiKey: string; model?: string } | { provider: "claude"; apiKey?: string };

/** Picks the LLM from env: LLM_PROVIDER, else GEMINI_API_KEY -> gemini, else an Anthropic key -> claude. */
export function llmFromEnv(env: NodeJS.ProcessEnv): LlmConfig | undefined {
  const provider = env.LLM_PROVIDER ?? (env.GEMINI_API_KEY ? "gemini" : env.ANTHROPIC_API_KEY || env.LLM_API_KEY ? "claude" : undefined);
  if (provider === "gemini") {
    const apiKey = env.GEMINI_API_KEY || env.LLM_API_KEY;
    return apiKey ? { provider, apiKey, model: env.GEMINI_MODEL || undefined } : undefined;
  }
  if (provider === "claude") return { provider, apiKey: env.LLM_API_KEY || undefined };
  return undefined;
}

export interface AgentResult {
  finalText: string;
  stopReason: string | null;
  /** full model conversation, for audits and leak checks */
  conversation: unknown[];
}

export async function runAgent(tools: BuyerTools, task: string, llm: LlmConfig, o: { maxTurns?: number; log?: (m: string) => void } = {}): Promise<AgentResult> {
  if (llm.provider === "gemini") {
    const r = await runGeminiAgent(tools, task, { apiKey: llm.apiKey, model: llm.model, maxTurns: o.maxTurns, log: o.log });
    return { finalText: r.finalText, stopReason: r.stopReason, conversation: r.contents };
  }
  const r = await runLlmAgent(tools, task, { apiKey: llm.apiKey, maxTurns: o.maxTurns });
  return { finalText: r.finalText, stopReason: r.stopReason, conversation: r.messages };
}
