"use client";
import { useEffect, useState } from "react";
import { motion, useMotionValue, useSpring, useTransform } from "motion/react";
import { mandate } from "@/lib/mock";

const ranges = ["1H", "1D", "1W", "1M", "1Y", "ALL"];

// Compact animated card showing a sealed mandate.
export function PhoneCard() {
  const [range, setRange] = useState(1);
  // Mouse-follow tilt
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const rotY = useSpring(useTransform(mx, [-1, 1], [-12, 12]), { stiffness: 120, damping: 14 });
  const rotX = useSpring(useTransform(my, [-1, 1], [10, -10]), { stiffness: 120, damping: 14 });
  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    mx.set(((e.clientX - r.left) / r.width) * 2 - 1);
    my.set(((e.clientY - r.top) / r.height) * 2 - 1);
  };
  const onLeave = () => { mx.set(0); my.set(0); };
  useEffect(() => {
    const t = setInterval(() => setRange((r) => (r + 1) % ranges.length), 2200);
    return () => clearInterval(t);
  }, []);

  const rows = [
    { icon: "🔒", label: "Max budget", value: "••••••", mask: true },
    { icon: "◎", label: "Per-deal cap", value: "••••••", mask: true },
    { icon: "⌘", label: "Categories", value: `${mandate.categories.length} allowed` },
    { icon: "⛓", label: "Sellers", value: `${mandate.sellers.length} allowed` },
  ];
  return (
    <motion.div
      initial={{ opacity: 0, x: 60, scale: 0.94 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      transition={{ duration: 0.9, ease: [0.2, 0.8, 0.2, 1] }}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      style={{ perspective: 900 }}
      className="relative mx-auto flex h-[440px] w-full max-w-[420px] items-center justify-center overflow-hidden rounded-[32px] bg-gradient-to-br from-blue via-blue-mid to-blue-deep">
      <span className="anim-drift absolute -left-10 -top-10 h-40 w-40 rounded-full bg-white/10 blur-2xl" />
      <span className="anim-drift absolute -bottom-12 -right-8 h-48 w-48 rounded-full bg-blue-soft/30 blur-2xl [animation-delay:-4s]" />
      <motion.div
        animate={{ y: [0, -12, 0] }}
        transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
        whileHover={{ scale: 1.04 }}
        style={{ rotateX: rotX, rotateY: rotY, transformStyle: "preserve-3d" }}
        className="w-[250px] rounded-[30px] border border-white/30 bg-white/15 p-2.5 backdrop-blur"
      >
        <div className="rounded-[22px] bg-white p-4 shadow-xl">
          <div className="flex items-center justify-between text-[11px] text-muted">
            <span>Sealed mandate</span>
            <span className="rounded-full bg-[#e6f6ee] px-2 py-0.5 text-up"><span className="anim-pulse">●</span> sealed</span>
          </div>
          <div className="mt-2 text-2xl font-normal tracking-tight">0x1f9c…a7e2</div>
          <div className="mt-0.5 text-[11px] text-up">↗ Only a hash is on-chain</div>
          <svg viewBox="0 0 240 70" className="mt-2 w-full" aria-hidden>
            <polyline className="anim-draw" fill="none" stroke="#0052ff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" points="0,55 20,50 40,53 60,40 80,44 100,32 120,36 140,24 160,28 180,16 200,20 220,8 240,12" />
          </svg>
          <div className="mt-2 flex justify-between text-[10px] text-muted">
            {ranges.map((t, i) => (
              <span key={t} className={`rounded-full px-1.5 py-0.5 transition-colors duration-300 ${i === range ? "bg-[#e5edff] text-blue" : ""}`}>{t}</span>
            ))}
          </div>
          <ul className="mt-3 space-y-2">
            {rows.map((r, i) => (
              <li key={r.label} className="anim-rise flex items-center justify-between text-xs" style={{ animationDelay: `${0.6 + i * 0.12}s` }}>
                <span className="flex items-center gap-2"><span aria-hidden>{r.icon}</span>{r.label}</span>
                <span className={`mono text-[11px] ${r.mask ? "anim-mask" : ""}`}>{r.value}</span>
              </li>
            ))}
          </ul>
        </div>
      </motion.div>
    </motion.div>
  );
}
