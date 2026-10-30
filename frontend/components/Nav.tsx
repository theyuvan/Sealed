"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "./Logo";
import { usePoll, type Overview } from "@/lib/api";

const links = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/negotiate", label: "Negotiate" },
  { href: "/attacks", label: "Attacks" },
  { href: "/receipts", label: "Receipts" },
];

export function Nav() {
  const path = usePathname();
  const { data, error } = usePoll<Overview>("/api/overview", 15000);
  const live = data && data.services.vault;
  const badge = live ? `${data.hspMode} · chain ${data.chainId}` : error ? "Backend offline" : "Connecting…";
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-white/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between px-6">
        <div className="flex items-center gap-10">
          <Link href="/" aria-label="Sealed home"><Logo /></Link>
          <nav className="hidden gap-8 md:flex">
            {links.map((l) => {
              const active = path === l.href || (l.href.startsWith("/receipts") && path.startsWith("/receipts"));
              return (
                <Link key={l.href} href={l.href} className={`text-[15px] font-medium hover:text-blue ${active ? "text-blue" : "text-ink"}`}>
                  {l.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden rounded-full bg-surface px-3 py-1.5 text-xs font-medium text-muted sm:inline">
            <span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${live ? "bg-up" : "bg-down"}`} />{badge}
          </span>
          <Link href="/dashboard" className="btn btn-blue !py-2.5">Open app</Link>
        </div>
      </div>
    </header>
  );
}
