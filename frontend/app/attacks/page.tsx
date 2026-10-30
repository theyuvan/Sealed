import { adversary, attacks } from "@/lib/mock";
import { Card, Pill } from "@/components/Ui";

export default function Attacks() {
  const max = Math.max(...adversary.series.map((s) => s.err), 1);
  return (
    <div className="mx-auto max-w-[1440px] px-6 py-12">
      <h1 className="display text-4xl md:text-5xl">Rogue seller attacks</h1>
      <p className="mt-2 text-muted">Six scripted attacks from the e2e suite. Logs below are simulated.</p>

      <div className="mt-10 grid gap-6 md:grid-cols-2">
        {attacks.map((a) => (
          <Card key={a.id}>
            <div className="flex items-start justify-between gap-4">
              <h2 className="text-xl font-medium">{a.id}. {a.name}</h2>
              <Pill tone="green">{a.result}</Pill>
            </div>
            <p className="mt-2 text-sm text-muted">{a.what}</p>
            <p className="mt-3 text-sm"><span className="font-medium">Stopped by:</span> {a.stoppedBy}</p>
            <pre className="mono mt-4 overflow-x-auto rounded-lg bg-night p-4 text-xs leading-5 text-white/80">{a.log.join("\n")}</pre>
          </Card>
        ))}
      </div>

      <div className="mt-16 rounded-[32px] bg-night p-8 text-white md:p-12">
        <h2 className="display text-3xl md:text-4xl">Budget inference error</h2>
        <p className="mt-3 max-w-2xl text-white/70">How far an adversary&apos;s estimate of the budget is from the truth. Higher is better for the buyer. Sealed reduces leakage; it does not eliminate it.</p>
        <div className="mt-10 space-y-6">
          {adversary.series.map((s) => (
            <div key={s.label}>
              <div className="flex justify-between text-sm"><span>{s.label}</span><span>{s.err.toFixed(1)}%</span></div>
              <div className="mt-2 h-4 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full" style={{ width: `${Math.max((s.err / max) * 100, 1)}%`, background: s.color }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
