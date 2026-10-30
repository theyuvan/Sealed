"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { negotiationScript, prompts } from "@/lib/mock";
import { Card, Pill } from "@/components/Ui";

const whoStyle = {
  seller: { label: "Seller", cls: "bg-surface" },
  vault: { label: "Vault", cls: "bg-[#e5edff]" },
  agent: { label: "Buyer agent", cls: "bg-white border border-line" },
  system: { label: "System", cls: "bg-night text-white" },
} as const;

export default function Negotiate() {
  const [shown, setShown] = useState(0);
  const [running, setRunning] = useState(false);
  const [asked, setAsked] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!running) return;
    if (shown >= negotiationScript.length) { setRunning(false); return; }
    const t = setTimeout(() => setShown((n) => n + 1), 1100);
    return () => clearTimeout(t);
  }, [running, shown]);

  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [shown]);

  const done = shown >= negotiationScript.length;
  const steps = negotiationScript.slice(0, shown);

  return (
    <div className="mx-auto max-w-[1440px] px-6 py-12">
      <h1 className="display text-4xl md:text-5xl">Negotiate with honest-1</h1>
      <p className="mt-2 text-muted">A simulated run of the full flow. The buyer agent only relays numbers; the Vault decides.</p>

      <div className="mt-10 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-medium">Live session</h2>
            <div className="flex gap-3">
              <button className="btn btn-ghost !py-2.5" onClick={() => { setShown(0); setRunning(false); }}>Reset</button>
              <button className="btn btn-blue !py-2.5" disabled={running || done} onClick={() => setRunning(true)}>
                {running ? "Running…" : shown === 0 ? "Start" : "Resume"}
              </button>
            </div>
          </div>
          <div className="mt-6 max-h-[560px] space-y-3 overflow-y-auto pr-1">
            {steps.length === 0 && <p className="py-16 text-center text-muted">Press Start to simulate a negotiation.</p>}
            {steps.map((s, i) => {
              const st = whoStyle[s.who];
              return (
                <div key={i} className={`rounded-xl p-4 ${st.cls}`}>
                  <div className="flex items-center justify-between text-xs opacity-70">
                    <span>{st.label}</span>
                    {s.tag && <span className="mono">{s.tag}</span>}
                  </div>
                  <div className="mt-1 text-[15px]">{s.text}</div>
                </div>
              );
            })}
            <div ref={end} />
          </div>
          {done && (
            <Link href="/receipts/0x5e41c2" className="btn btn-dark mt-6">View receipt</Link>
          )}
        </Card>

        <div className="space-y-6">
          <Card>
            <h2 className="text-xl font-medium">Try to extract the budget</h2>
            <p className="mt-2 text-sm text-muted">What a malicious seller might send to the buyer agent.</p>
            <div className="mt-4 rounded-lg bg-surface p-3 text-sm">{prompts.attack}</div>
            <button className="btn btn-ghost mt-3 !py-2.5" onClick={() => setAsked(true)}>Send</button>
            {asked && <div className="mt-3 rounded-lg bg-[#e5edff] p-3 text-sm">{prompts.reply}</div>}
          </Card>
          <Card>
            <h2 className="text-xl font-medium">What the agent knows</h2>
            <ul className="mt-4 space-y-2 text-sm">
              <li className="flex justify-between"><span>Max budget</span><Pill>not available</Pill></li>
              <li className="flex justify-between"><span>Distance to target</span><Pill>not available</Pill></li>
              <li className="flex justify-between"><span>Latest decision</span><Pill tone="blue">{done ? "accept" : shown > 2 ? "counter" : "–"}</Pill></li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
