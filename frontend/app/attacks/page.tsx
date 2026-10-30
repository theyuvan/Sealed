"use client";
import { attacks } from "@/lib/mock";
import { Card, Pill } from "@/components/Ui";
import { usePoll } from "@/lib/api";

type Report = { simulated: { runs: number; baselineMape: number; baselineMapeAware: number; sealedMapeGeneric: number; sealedMapeAware: number; note: string } };

export default function Attacks() {
  const { data, error } = usePoll<Report>("/api/adversary", 60000);
  const s = data?.simulated;
  const series = s
    ? [
        { group: "Algorithm-aware adversary", rows: [{ label: "Budget in prompt", err: s.baselineMapeAware * 100, color: "#cf202f" }, { label: "Sealed", err: s.sealedMapeAware * 100, color: "#0052ff" }] },
        { group: "Generic trend estimator", rows: [{ label: "Budget in prompt", err: s.baselineMape * 100, color: "#cf202f" }, { label: "Sealed", err: s.sealedMapeGeneric * 100, color: "#0052ff" }] },
      ]
    : [];
  const max = Math.max(1, ...series.flatMap((g) => g.rows.map((r) => r.err)));

  return (
    <div className="mx-auto max-w-[1440px] px-6 py-12">
      <h1 className="display text-4xl md:text-5xl">Rogue seller attacks</h1>
      <p className="mt-2 text-muted">Six attacks, each run against the real stack by <span className="mono">backend/tests/e2e/attacks.test.ts</span> (run <span className="mono">npm run test:e2e</span> in backend). This page describes them; it does not replay them.</p>

      <div className="mt-10 grid gap-6 md:grid-cols-2">
        {attacks.map((a) => (
          <Card key={a.id}>
            <div className="flex items-start justify-between gap-4">
              <h2 className="text-xl font-medium">{a.id}. {a.name}</h2>
              <Pill tone="green">blocked</Pill>
            </div>
            <p className="mt-2 text-sm text-muted">{a.what}</p>
            <p className="mt-3 text-sm"><span className="font-medium">Stopped by:</span> {a.stoppedBy}</p>
          </Card>
        ))}
      </div>

      <div className="mt-16 rounded-[32px] bg-night p-8 text-white md:p-12">
        <h2 className="display text-3xl md:text-4xl">Budget inference error</h2>
        <p className="mt-3 max-w-2xl text-white/70">How far an adversary&apos;s estimate of the budget is from the truth. Higher is better for the buyer. Sealed reduces leakage; it does not eliminate it.</p>
        {!s ? (
          <p className="mt-8 text-white/70">{error ?? "Loading…"}</p>
        ) : (
          <div className="mt-10 space-y-10">
            {series.map((g) => (
              <div key={g.group}>
                <div className="text-sm text-white/60">{g.group}</div>
                <div className="mt-3 space-y-5">
                  {g.rows.map((r) => (
                    <div key={r.label}>
                      <div className="flex justify-between text-sm"><span>{r.label}</span><span>{r.err.toFixed(1)}%</span></div>
                      <div className="mt-2 h-4 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full" style={{ width: `${Math.max((r.err / max) * 100, 1)}%`, background: r.color }} /></div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <p className="text-xs text-white/50">{s.runs} simulated runs from backend/data/adversary-report.json. {s.note}</p>
          </div>
        )}
      </div>
    </div>
  );
}
