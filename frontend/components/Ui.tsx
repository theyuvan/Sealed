import { ReactNode } from "react";

export function Section({ children, className = "", dark = false, tint = false }: { children: ReactNode; className?: string; dark?: boolean; tint?: boolean }) {
  const bg = dark ? "bg-night text-white" : tint ? "bg-surface" : "bg-white";
  return (
    <section className={`${bg} ${className}`}>
      <div className="mx-auto max-w-[1440px] px-6 py-20 md:py-28">{children}</div>
    </section>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-card border border-line bg-white p-6 ${className}`}>{children}</div>;
}

export function Pill({ children, tone = "gray" }: { children: ReactNode; tone?: "gray" | "green" | "red" | "blue" }) {
  const t = { gray: "bg-surface text-muted", green: "bg-[#e6f6ee] text-up", red: "bg-[#fbe9ea] text-down", blue: "bg-[#e5edff] text-blue" }[tone];
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${t}`}>{children}</span>;
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div>
      <div className="text-sm text-muted">{label}</div>
      <div className="mt-1 text-3xl font-normal tracking-tight">{value}</div>
      {sub && <div className="mt-1 text-sm text-muted">{sub}</div>}
    </div>
  );
}

export function Change({ v }: { v: number }) {
  const up = v >= 0;
  return <span className={`text-xs ${up ? "text-up" : "text-down"}`}>{up ? "↗" : "↙"} {Math.abs(v).toFixed(2)}%</span>;
}
