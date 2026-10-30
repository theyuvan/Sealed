// Dark tablet + phone mock, like the "advanced trader" block in the reference.
export function AppPreview() {
  return (
    <div className="flex min-h-[320px] items-center justify-center gap-4 rounded-[32px] bg-night p-8">
      <div className="w-full max-w-[420px] rounded-2xl border-2 border-blue bg-[#111318] p-3">
        <div className="flex gap-1.5 pb-2">
          {[0, 1, 2].map((i) => <span key={i} className="h-1.5 w-1.5 rounded-full bg-white/30" />)}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="col-span-2 rounded-lg bg-black/40 p-2">
            <svg viewBox="0 0 200 90" className="w-full" aria-hidden>
              {Array.from({ length: 24 }).map((_, i) => {
                const h = 12 + ((i * 37) % 38);
                const y = 20 + ((i * 53) % 30);
                return <rect key={i} x={4 + i * 8} y={y} width="4" height={h} fill={i % 3 !== 0 ? "#05b169" : "#cf202f"} />;
              })}
            </svg>
          </div>
          <div className="space-y-1 rounded-lg bg-black/40 p-2 text-[8px] leading-4">
            {["14.00", "12.50", "10.20", "9.40", "9.37"].map((p, i) => (
              <div key={p} className={`flex justify-between ${i < 3 ? "text-down" : "text-up"}`}><span>{p}</span><span className="text-white/40">USDC</span></div>
            ))}
          </div>
        </div>
      </div>
      <div className="hidden w-[110px] rounded-2xl border-2 border-blue bg-[#111318] p-2 sm:block">
        <div className="space-y-1.5 text-[8px] text-white/60">
          <div className="rounded bg-up/20 px-1.5 py-1 text-up">Proof ✓</div>
          <div className="rounded bg-white/5 px-1.5 py-1">Call 1 · 3.13</div>
          <div className="rounded bg-white/5 px-1.5 py-1">Call 2 · 6.27</div>
          <div className="rounded bg-white/5 px-1.5 py-1">Call 3 · 9.40</div>
        </div>
      </div>
    </div>
  );
}
