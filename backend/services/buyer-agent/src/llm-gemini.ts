import { SYSTEM_PROMPT, TOOL_DEFS } from "./llm.ts";
import type { BuyerTools } from "./tools.ts";

/** Default model; override with GEMINI_MODEL. */
export const GEMINI_MODEL = "gemini-3.5-flash";
const API = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; id?: string; response: Record<string, unknown> };
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/** The same seven tools as the Claude agent, as Gemini function declarations (OpenAPI-style schema). */
export const GEMINI_TOOLS = [
  {
    functionDeclarations: TOOL_DEFS.map((t) => {
      const schema = t.input_schema as { properties?: Record<string, unknown>; required?: string[] };
      const hasParams = schema.properties && Object.keys(schema.properties).length > 0;
      return {
        name: t.name,
        description: t.description,
        ...(hasParams ? { parameters: { type: "object", properties: schema.properties, required: schema.required ?? [] } } : {}),
      };
    }),
  },
];

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function generate(apiKey: string, model: string, body: unknown, log?: (m: string) => void): Promise<{ candidates?: { content?: GeminiContent; finishReason?: string }[]; promptFeedback?: unknown }> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${API}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const j = (await r.json().catch(() => ({}))) as { error?: { message?: string; details?: { retryDelay?: string }[] } } & Record<string, unknown>;
    if (r.ok) return j as never;
    // 429 (per-minute quota) and 5xx ("high demand") are transient: wait as long as Gemini asks, then retry
    const retryable = r.status === 429 || r.status >= 500;
    if (!retryable || attempt >= 7) throw new GeminiError(`Gemini ${r.status}: ${j.error?.message ?? "request failed"}`, r.status);
    const hinted = j.error?.details?.find((d) => d.retryDelay)?.retryDelay;
    const waitMs = hinted ? Math.ceil(parseFloat(hinted) * 1000) + 1_000 : Math.min(60_000, 2_000 * 2 ** attempt);
    // a long hinted delay means a daily quota (free tier: 20 requests/day per model), not a burst limit
    if (waitMs > 120_000) throw new GeminiError(`Gemini quota exhausted for ${model} (retry in ${Math.round(waitMs / 3_600_000)}h); set GEMINI_MODEL to another model or enable billing`, r.status);
    log?.(`Gemini ${r.status}, retrying in ${Math.round(waitMs / 1000)}s`);
    await new Promise((res) => setTimeout(res, waitMs));
  }
}

export interface GeminiRun {
  finalText: string;
  contents: GeminiContent[];
  stopReason: string | null;
}

/**
 * Gemini function-calling loop over the same BuyerTools as the Claude agent. History is append-only:
 * each model turn is pushed back unchanged (it carries thought signatures Gemini requires), and all
 * function responses of a turn go back in one user turn, matched by call id.
 */
export async function runGeminiAgent(tools: BuyerTools, task: string, o: { apiKey: string; model?: string; maxTurns?: number; log?: (m: string) => void }): Promise<GeminiRun> {
  const model = o.model ?? GEMINI_MODEL;
  const contents: GeminiContent[] = [{ role: "user", parts: [{ text: task }] }];
  let stopReason: string | null = null;
  let finalText = "";
  for (let turn = 0; turn < (o.maxTurns ?? 40); turn++) {
    const res = await generate(o.apiKey, model, {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      tools: GEMINI_TOOLS,
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    }, o.log);
    const candidate = res.candidates?.[0];
    stopReason = candidate?.finishReason ?? "BLOCKED";
    if (!candidate?.content?.parts?.length) break;
    contents.push({ role: "model", parts: candidate.content.parts });

    const calls = candidate.content.parts.filter((p) => p.functionCall);
    if (calls.length === 0) {
      finalText = candidate.content.parts
        .filter((p) => p.text && !p.thought)
        .map((p) => p.text)
        .join("\n");
      break;
    }
    const responses: GeminiPart[] = [];
    for (const p of calls) {
      const fc = p.functionCall!;
      const result = await tools.run(fc.name, fc.args ?? {});
      o.log?.(`turn ${turn + 1}: ${fc.name}${"decision" in result ? ` -> ${String(result.decision)}` : ""}${"error" in result ? ` -> error: ${String(result.error).slice(0, 120)}` : ""}`);
      responses.push({ functionResponse: { name: fc.name, ...(fc.id ? { id: fc.id } : {}), response: "error" in result ? { error: result.error } : { result } } });
    }
    contents.push({ role: "user", parts: responses });
  }
  return { finalText, contents, stopReason };
}
