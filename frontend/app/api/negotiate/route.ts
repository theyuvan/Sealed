import { buyer, config, jsonError } from "@/lib/backend";

/** Start a buyer-agent run. "scripted" is the deterministic driver; "llm" needs the buyer agent to have an LLM key. */
export async function POST(req: Request) {
  try {
    const b = (await req.json()) as { mode?: "scripted" | "llm"; sellerUrl?: string; serviceId?: string; calls?: number; task?: string };
    if (b.mode === "llm") {
      return Response.json(await buyer("/run", { method: "POST", body: JSON.stringify({ mode: "llm", task: String(b.task ?? "").slice(0, 4000) }) }));
    }
    if (!b.sellerUrl || !config.sellerUrls.includes(b.sellerUrl)) throw new Error("unknown seller");
    const calls = Math.min(Math.max(Number(b.calls ?? 2), 1), 10);
    return Response.json(await buyer("/run", { method: "POST", body: JSON.stringify({ mode: "scripted", sellerUrl: b.sellerUrl, serviceId: String(b.serviceId), calls }) }));
  } catch (e) {
    return jsonError(e);
  }
}
