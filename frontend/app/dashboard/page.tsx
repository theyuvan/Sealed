"use client";
import { useState } from "react";
import Link from "next/link";
import { Card, Pill, Stat } from "@/components/Ui";
import { contracts, EXPLORER, mandate, receipts } from "@/lib/mock";

export default function Dashboard() {
  const [status, setStatus] = useState(mandate.status);
  const [reveal, setReveal] = useState(false);
  const pct = Math.round((mandate.evaluationsUsed / mandate.evaluationsLimit) * 100);

  return (
    <div className="mx-auto max-w-[1440px] px-6 py-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="display text-4xl md:text-5xl">Your mandate</h1>
          <p className="mt-2 text-muted">The Vault holds the rules. The buyer agent never sees them.</p>
        </div>
        <div className="flex gap-3">
          <button className="btn btn-ghost" onClick={() => setStatus("sealed")}>Rotate</button>
          <button className="btn btn-dark" onClick={() => setStatus("revoked")} disabled={status === "revoked"}>Revoke</button>
        </div>
      </div>

      <div className="mt-10 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-medium">On-chain commitment</h2>
            <Pill tone={status === "sealed" ? "green" : "red"}>{status}</Pill>
          </div>
          <div className="mono mt-4 break-all rounded-lg bg-surface p-4 text-sm">{mandate.commitment} · leaf #{mandate.leafIndex}</div>
          <div className="mt-6 grid gap-6 sm:grid-cols-3">
            <Stat label="Max budget" value={reveal ? `${mandate.maxRemaining} USDC` : "••••••"} />
            <Stat label="Per-deal cap" value={reveal ? `${mandate.perDealCap} USDC` : "••••••"} />
            <Stat label="Expiry" value={<span className="text-xl">{mandate.expiry}</span>} />
          </div>
          <button onClick={() => setReveal(!reveal)} className="mt-6 text-sm font-medium text-blue">
            {reveal ? "Hide values" : "Reveal values (owner view only)"}
          </button>
          <div className="mt-6 grid gap-6 sm:grid-cols-2">
            <div>
              <div className="text-sm text-muted">Allowed categories</div>
              <div className="mt-2 flex flex-wrap gap-2">{mandate.categories.map((c) => <Pill key={c} tone="blue">{c}</Pill>)}</div>
            </div>
            <div>
              <div className="text-sm text-muted">Allowed sellers</div>
              <div className="mt-2 flex flex-wrap gap-2">{mandate.sellers.map((c) => <Pill key={c}>{c}</Pill>)}</div>
            </div>
          </div>
        </Card>

        <Card>
          <h2 className="text-xl font-medium">Probe limits</h2>
          <div className="mt-4 text-3xl">{mandate.evaluationsUsed} <span className="text-lg text-muted">/ {mandate.evaluationsLimit}</span></div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface"><div className="h-full rounded-full bg-blue" style={{ width: `${pct}%` }} /></div>
          <p className="mt-3 text-sm text-muted">Global evaluations per mandate. At the limit the mandate is rotated under a new id.</p>
          <div className="mt-6 text-sm text-muted">Pinned token</div>
          <div className="mt-1 text-lg">{mandate.token}</div>
          <div className="mono text-xs text-muted break-all">{mandate.tokenAddress}</div>
        </Card>
      </div>

      <div className="mt-10 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-medium">Recent sessions</h2>
            <Link href="/negotiate" className="text-sm font-medium text-blue">New negotiation →</Link>
          </div>
          <table className="mt-4 w-full text-left text-sm">
            <thead className="text-muted"><tr><th className="py-2 font-normal">Seller</th><th className="font-normal">Service</th><th className="font-normal">Paid</th><th className="font-normal">Refunded</th><th /></tr></thead>
            <tbody>
              {receipts.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="py-3">{r.seller}</td><td>{r.service}</td><td>{r.paid.toFixed(2)}</td><td>{r.refunded.toFixed(2)}</td>
                  <td className="text-right"><Link href={`/receipts/${r.id}`} className="text-blue">Receipt</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card>
          <h2 className="text-xl font-medium">Contracts · testnet 133</h2>
          <ul className="mt-4 space-y-4">
            {contracts.map((c) => (
              <li key={c.name}>
                <div className="text-sm">{c.name}</div>
                <a href={`${EXPLORER}/address/${c.address}`} target="_blank" rel="noreferrer" className="mono break-all text-xs text-blue">{c.address}</a>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
