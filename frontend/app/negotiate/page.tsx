"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Card, Pill } from "@/components/Ui";
import { api, usePoll, type Overview } from "@/lib/api";

type Out = Record<string, unknown>;
type Entry = { tool: string; input: Out; output: Out };
type Run = { status: "running" | "done" | "failed"; transcript: Entry[]; outcome?: string; error?: string; sessionId?: string; receipt?: unknown };

const STYLE = {
  seller: { label: "Seller", cls: "bg-surface" },
  vault: { label: "Vault", cls: "bg-[#e5edff]" },
  agent: { label: "Buyer agent", cls: "bg-white border border-line" },
  system: { label: "System", cls: "bg-night text-white" },
} as const;

/** One transcript entry -> who says what. Only fields the agent itself sees; the mandate is never in a transcript. */
function describe(e: Entry): { who: keyof typeof STYLE; text: string } {
  const o = e.output;
  if (o.error) return { who: "system", text: `${e.tool}: ${String(o.error)}` };
  switch (e.tool) {
    case "discover_sellers":
      return { who: "agent", text: `Found ${(o.sellers as unknown[] | undefined)?.length ?? 0} sellers.` };
    case "request_quote":
      return { who: "seller", text: `Signed quote: ${String(o.price)} for ${String(o.calls)} calls.${o.seller_message ? ` "${String(o.seller_message)}"` : ""}` };
    case "propose":
      return o.decision === "counter"
        ? { who: "vault", text: `Counter-offer: ${String(o.counter_offer_display ?? o.counter_offer)}.` }
        : { who: "vault", text: o.decision === "accept" ? "Accept. (No reason or distance is ever returned.)" : "Walk away." };
    case "open_session":
      return { who: "system", text: `Spend proof verified on chain, session opened and funded through HSP: ${String(o.status)}, ${String(o.calls)} calls at ${String(o.price_per_call)}.` };
    case "call_service":
      return { who: "agent", text: o.paid ? `Call delivered and checked; voucher signed (${String(o.cumulative_paid ?? o.paid_so_far ?? "paid")}).` : `Delivery rejected, nothing paid: ${JSON.stringify(o.check ?? o)}` };
    case "check_delivery":
      return { who: "agent", text: `Delivery check: ${JSON.stringify(o)}` };
    case "close_session":
      return { who: "system", text: o.receipt ? "Session closed. Receipt emitted." : `Close: ${JSON.stringify(o)}` };
    default:
      return { who: "agent", text: `${e.tool}: ${JSON.stringify(o).slice(0, 200)}` };
  }
}

export default function Negotiate() {
  const { data: o } = usePoll<Overview>("/api/overview", 15000);
  const [sellerUrl, setSellerUrl] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [calls, setCalls] = useState(2);
  const [mode, setMode] = useState<"scripted" | "llm">("scripted");
  const [task, setTask] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  const seller = o?.sellers.find((s) => s.url === sellerUrl) ?? o?.sellers[0];
  const svc = seller?.services.find((s) => s.id === serviceId) ?? seller?.services[0];

  useEffect(() => {
    if (!runId) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await api<Run>(`/api/negotiate/${runId}`);
        if (stop) return;
        setRun(r);
        if (r.status === "running") setTimeout(tick, 1500);
      } catch (e) {
        if (!stop) setErr((e as Error).message);
      }
    };
    void tick();
    return () => { stop = true; };
  }, [runId]);

  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [run?.transcript.length]);

  const start = async () => {
    if (!seller || !svc) return;
    setErr(null);
    setRun(null);
    try {
      const body = mode === "llm" ? { mode, task: task.trim() || `Buy ${calls} calls of the "${svc.id}" service from the seller at ${seller.url}, then close the session.` } : { mode, sellerUrl: seller.url, serviceId: svc.id, calls };
      const r = await api<{ id?: string; error?: string }>("/api/negotiate", { method: "POST", body: JSON.stringify(body) });
      if (!r.id) throw new Error(r.error ?? "no run id");
      setRunId(r.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const steps = run?.transcript ?? [];
  const running = run?.status === "running" || (runId !== null && run === null);
  const opened = steps.find((s) => s.tool === "open_session" && s.output.session_id);
  const sessionId = (run?.sessionId ?? opened?.output.session_id) as string | undefined;
  const finalText = (run as (Run & { finalText?: string }) | null)?.finalText;
  const lastDecision = [...steps].reverse().find((s) => s.tool === "propose")?.output.decision as string | undefined;

  return (
    <div className="mx-auto max-w-[1440px] px-6 py-12">
      <h1 className="display text-4xl md:text-5xl">Negotiate{seller ? ` with ${seller.name}` : ""}</h1>
      <p className="mt-2 text-muted">A real run on the live stack. The buyer agent only relays numbers; the Vault decides, proves and the chain checks.</p>

      <div className="mt-10 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex flex-wrap gap-3 text-sm">
              <label>Driver
                <select className="mt-1 block rounded-lg border border-line bg-white px-3 py-2" value={mode} onChange={(e) => setMode(e.target.value as "scripted" | "llm")}>
                  <option value="scripted">Scripted (deterministic)</option>
                  <option value="llm" disabled={!o?.llm}>LLM agent{o?.llm ? ` (${o.llm})` : " (no key configured)"}</option>
                </select>
              </label>
              <label>Seller
                <select className="mt-1 block rounded-lg border border-line bg-white px-3 py-2" value={seller?.url ?? ""} onChange={(e) => { setSellerUrl(e.target.value); setServiceId(""); }}>
                  {o?.sellers.map((s) => <option key={s.url} value={s.url}>{s.name}</option>)}
                </select>
              </label>
              <label>Service
                <select className="mt-1 block rounded-lg border border-line bg-white px-3 py-2" value={svc?.id ?? ""} onChange={(e) => setServiceId(e.target.value)}>
                  {seller?.services.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
                </select>
              </label>
              <label>Calls
                <input type="number" min={1} max={10} className="mt-1 block w-20 rounded-lg border border-line bg-white px-3 py-2" value={calls} onChange={(e) => setCalls(Number(e.target.value))} />
              </label>
            </div>
            <button className="btn btn-blue !py-2.5" disabled={running || !seller} onClick={start}>{running ? "Running…" : run ? "Run again" : "Start"}</button>
          </div>
          {mode === "llm" && (
            <label className="mt-4 block text-sm">Task for the agent (optional)
              <textarea className="mt-1 block w-full rounded-lg border border-line bg-white px-3 py-2" rows={2} maxLength={4000} value={task} onChange={(e) => setTask(e.target.value)} placeholder={`Buy ${calls} calls of "${svc?.id ?? "a service"}" from the seller at ${seller?.url ?? "…"}, then close the session.`} />
              <span className="text-xs text-muted">The model sees only the seven buyer tools. Free-tier LLM keys allow few requests a day; one purchase uses about 13 to 15.</span>
            </label>
          )}
          {seller?.notice && <p className="mt-3 rounded-lg bg-[#fbe9ea] p-3 text-xs text-down">This seller advertises an injection attempt in its agent card: {seller.notice.slice(0, 160)}</p>}
          {err && <div className="mt-4 rounded-lg bg-[#fbe9ea] p-3 text-sm text-down">{err}</div>}

          <div className="mt-6 max-h-[560px] space-y-3 overflow-y-auto pr-1">
            {steps.length === 0 && <p className="py-16 text-center text-muted">{running ? "Waiting for the first step…" : "Press Start. A full run takes about a minute: a Groth16 proof and a few transactions."}</p>}
            {steps.map((s, i) => {
              const d = describe(s);
              const st = STYLE[d.who];
              return (
                <div key={i} className={`rounded-xl p-4 ${st.cls}`}>
                  <div className="flex items-center justify-between text-xs opacity-70"><span>{st.label}</span><span className="mono">{s.tool}</span></div>
                  <div className="mt-1 text-[15px] break-words">{d.text}</div>
                </div>
              );
            })}
            {finalText && <div className="rounded-xl border border-line p-4 text-sm"><div className="text-xs opacity-70">Agent&apos;s final answer</div><div className="mt-1 whitespace-pre-wrap break-words">{finalText}</div></div>}
            {run?.status === "failed" && <div className="rounded-xl bg-[#fbe9ea] p-4 text-sm text-down">Run failed: {run.error}</div>}
            <div ref={end} />
          </div>
          {sessionId && (
            <Link href={`/receipts/${sessionId}`} className="btn btn-dark mt-6">{run?.status === "done" ? "View receipt and proof" : "View session"}</Link>
          )}
        </Card>

        <div className="space-y-6">
          <Card>
            <h2 className="text-xl font-medium">What the agent knows</h2>
            <ul className="mt-4 space-y-2 text-sm">
              <li className="flex justify-between"><span>Max budget</span><Pill>not available</Pill></li>
              <li className="flex justify-between"><span>Distance to target</span><Pill>not available</Pill></li>
              <li className="flex justify-between"><span>Latest decision</span><Pill tone="blue">{lastDecision ?? "–"}</Pill></li>
            </ul>
            <p className="mt-4 text-xs text-muted">The buyer agent holds a token that can only call four Vault routes. Mandate routes answer 403 to it.</p>
          </Card>
          <Card>
            <h2 className="text-xl font-medium">Run</h2>
            <dl className="mt-3 space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-muted">Status</dt><dd>{run?.status ?? "–"}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Outcome</dt><dd>{run?.outcome ?? "–"}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Payments</dt><dd>{o?.hspMode ?? "–"}</dd></div>
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}
