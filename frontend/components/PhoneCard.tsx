import { mandate } from "@/lib/mock";

// Stylised phone showing a sealed mandate, like the hero in the reference design.
export function PhoneCard() {
  const rows = [
    { icon: "🔒", label: "Max budget", value: "••••••" },
    { icon: "◎", label: "Per-deal cap", value: "••••••" },
    { icon: "⌘", label: "Categories", value: `${mandate.categories.length} allowed` },
    { icon: "⛓", label: "Sellers", value: `${mandate.sellers.length} allowed` },
  ];
  return (
    <div className="relative flex min-h-[460px] items-center justify-center overflow-hidden rounded-[32px] bg-gradient-to-br from-blue via-blue-mid to-blue-deep p-8 md:min-h-[560px]">
      <div className="w-[300px] rounded-[36px] border border-white/30 bg-white/15 p-3 backdrop-blur">
        <div className="rounded-[28px] bg-white p-5 shadow-xl">
          <div className="flex items-center justify-between text-xs text-muted">
            <span>Sealed mandate</span>
            <span className="rounded-full bg-[#e6f6ee] px-2 py-0.5 text-up">● sealed</span>
          </div>
          <div className="mt-3 text-3xl font-normal tracking-tight">0x1f9c…a7e2</div>
          <div className="mt-1 text-xs text-up">↗ Only a hash is on-chain</div>
          <svg viewBox="0 0 240 70" className="mt-3 w-full" aria-hidden>
            <polyline fill="none" stroke="#0052ff" strokeWidth="2" points="0,55 20,50 40,53 60,40 80,44 100,32 120,36 140,24 160,28 180,16 200,20 220,8 240,12" />
          </svg>
          <div className="mt-3 flex justify-between text-[11px] text-muted">
            {["1H", "1D", "1W", "1M", "1Y", "ALL"].map((t) => (
              <span key={t} className={t === "1D" ? "rounded-full bg-[#e5edff] px-2 py-0.5 text-blue" : ""}>{t}</span>
            ))}
          </div>
          <ul className="mt-4 space-y-3">
            {rows.map((r) => (
              <li key={r.label} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2"><span aria-hidden>{r.icon}</span>{r.label}</span>
                <span className="mono text-xs">{r.value}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
