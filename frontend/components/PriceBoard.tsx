"use client";
import { useState } from "react";
import { sellers } from "@/lib/mock";
import { Change } from "./Ui";

const tabs = ["All", "Honest", "Rogue"] as const;

export function PriceBoard() {
  const [tab, setTab] = useState<(typeof tabs)[number]>("All");
  const rows = sellers.filter((s) => tab === "All" || (tab === "Honest" ? s.kind === "honest" : s.kind === "rogue"));
  return (
    <div className="rounded-[28px] bg-night p-6 text-white">
      <div className="flex gap-2">
        {tabs.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-full px-4 py-2 text-sm ${tab === t ? "bg-white/15" : "text-white/70"}`}>{t}</button>
        ))}
      </div>
      <ul className="mt-6 divide-y divide-white/5">
        {rows.map((s) => (
          <li key={s.id} className="flex items-center justify-between py-5">
            <div className="flex items-center gap-4">
              <span className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold ${s.kind === "rogue" ? "bg-down" : "bg-blue"}`}>{s.name[0].toUpperCase()}</span>
              <div>
                <div className="text-xl">{s.name}</div>
                <div className="text-xs text-white/60">{s.service}</div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-lg">{s.price.toFixed(2)} USDC</div>
              <Change v={s.change} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
