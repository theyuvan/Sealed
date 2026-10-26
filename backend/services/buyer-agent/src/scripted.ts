import type { BuyerTools, ToolResult } from "./tools.ts";

export interface ScriptedPlan {
  sellerUrl: string;
  serviceId: string;
  calls: number;
  maxRounds?: number;
}

/**
 * Deterministic, non-LLM driver over the same tools the LLM uses. For tests and for running the
 * flow without an LLM key. It has exactly the LLM's access: the BuyerTools surface, nothing more.
 */
export async function runScripted(tools: BuyerTools, plan: ScriptedPlan): Promise<{ steps: ToolResult[]; sessionId?: string; receipt?: unknown; outcome: string }> {
  const steps: ToolResult[] = [];
  const step = async (name: string, input: Record<string, unknown> = {}) => {
    const r = await tools.run(name, input);
    steps.push({ tool: name, ...r });
    return r;
  };
  await step("discover_sellers");
  let q = await step("request_quote", { seller_url: plan.sellerUrl, service_id: plan.serviceId });
  if (q.error) return { steps, outcome: "quote-error" };
  for (let round = 0; round < (plan.maxRounds ?? 12); round++) {
    const d = await step("propose", { quote_id: q.quote_id });
    if (d.decision === "accept") {
      const s = await step("open_session", { quote_id: q.quote_id });
      if (s.error) return { steps, sessionId: s.session_id as string | undefined, outcome: "open-failed" };
      const sessionId = s.session_id as string;
      for (let i = 0; i < plan.calls; i++) {
        const c = await step("call_service", { session_id: sessionId });
        if (!c.paid) return { steps, sessionId, outcome: "delivery-rejected" };
      }
      const closed = await step("close_session", { session_id: sessionId });
      return { steps, sessionId, receipt: closed.receipt, outcome: closed.receipt ? "closed" : "close-pending" };
    }
    if (d.decision !== "counter") return { steps, outcome: "walked" };
    q = await step("request_quote", { seller_url: plan.sellerUrl, service_id: plan.serviceId, rfq_id: d.rfq_id, counter_offer: d.counter_offer });
    if (q.error) return { steps, outcome: "quote-error" };
  }
  return { steps, outcome: "max-rounds" };
}
