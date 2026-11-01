"use client";
import { useState } from "react";
import Link from "next/link";
import { Card, Pill, Stat } from "@/components/Ui";
import { api, usePoll, type Overview, type ProofRecord } from "@/lib/api";
import { short, usdc, when } from "@/lib/format";

const CATEGORY_LABELS: Record<string, string> = { "data.nav": "NAV snapshots", "data.holders": "Holder distribution", "data.transfers": "Recent transfers" };

export default function Dashboard() {
  const { data: o, error, reload } = usePoll<Overview>("/api/overview", 4000);
  const { data: proofs } = usePoll<ProofRecord[]>("/api/proofs", 8000);
  const [reveal, setReveal] = useState<{ remaining: string; perDealCap: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setMsg(null);
    try {
      await fn();
      setReveal(null);
      await reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (error && !o) return <Offline error={error} />;
  if (!o) return <div className="mx-auto max-w-[1440px] px-6 py-12 text-muted">Loading…</div>;

  const m = o.mandate;
  const dec = o.decimals;
  const pct = m ? Math.min(100, Math.round((m.evaluations / o.probeLimit) * 100)) : 0;
  const expiry = m?.expiry ? new Date(Number(m.expiry) * 1000).toUTCString() : "–";

  return (
    <div className="mx-auto max-w-[1440px] px-6 py-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="display text-4xl md:text-5xl">Your mandate</h1>
          <p className="mt-2 text-muted">The Vault holds the rules. The buyer agent never sees them.</p>
        </div>
        {m?.active && (
          <div className="flex gap-3">
            <button className="btn btn-ghost" disabled={busy !== null} onClick={() => act("rotate", () => api("/api/mandate/rotate", { method: "POST" }))}>{busy === "rotate" ? "Rotating…" : "Rotate"}</button>
            <button className="btn btn-dark" disabled={busy !== null} onClick={() => act("revoke", () => api("/api/mandate/revoke", { method: "POST" }))}>{busy === "revoke" ? "Revoking…" : "Revoke"}</button>
          </div>
        )}
      </div>
      {msg && <div className="mt-4 rounded-lg bg-[#fbe9ea] p-3 text-sm text-down">{msg}</div>}

      <div className="mt-6 flex flex-wrap gap-2 text-xs">
        <Pill tone={o.services.vault ? "green" : "red"}>vault {o.services.vault ? "up" : "down"}</Pill>
        <Pill tone={o.services.coordinator ? "green" : "red"}>coordinator {o.services.coordinator ? "up" : "down"}</Pill>
        <Pill tone={o.services.sellers > 0 ? "green" : "red"}>{o.services.sellers} sellers</Pill>
        <Pill tone="blue">chain {o.chainId}</Pill>
        <Pill tone={o.hspMode === "HSP" ? "green" : "gray"}>{o.hspMode}</Pill>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-medium">On-chain commitment</h2>
            <Pill tone={m?.active ? "green" : "red"}>{m?.active ? "sealed" : "no active mandate"}</Pill>
          </div>
          {m?.active ? (
            <>
              <div className="mono mt-4 break-all rounded-lg bg-surface p-4 text-sm">{m.commitment}</div>
              <div className="mt-6 grid gap-6 sm:grid-cols-3">
                <Stat label="Remaining budget" value={reveal ? `${usdc(reveal.remaining, dec)} USDC` : "••••••"} />
                <Stat label="Per-deal cap" value={reveal ? `${usdc(reveal.perDealCap, dec)} USDC` : "••••••"} />
                <Stat label="Expiry" value={<span className="text-xl">{expiry}</span>} />
              </div>
              <button
                onClick={() => (reveal ? setReveal(null) : (async () => { setMsg(null); try { const s = await api<{ remaining: string; perDealCap: string }>("/api/mandate?reveal=1"); setReveal({ remaining: s.remaining, perDealCap: s.perDealCap }); } catch (e) { setMsg((e as Error).message); } })())}
                className="mt-6 text-sm font-medium text-blue"
              >
                {reveal ? "Hide values" : "Reveal values (owner view only)"}
              </button>
              {m.pendingSpend && <p className="mt-3 text-sm text-muted">A spend proof is pending: the next one waits until the chain consumes it.</p>}
            </>
          ) : (
            <SealForm o={o} busy={busy === "seal"} onSeal={(b) => act("seal", () => api("/api/mandate", { method: "POST", body: JSON.stringify(b) }))} />
          )}
        </Card>

        <Card>
          <h2 className="text-xl font-medium">Probe limits</h2>
          <div className="mt-4 text-3xl">{m?.evaluations ?? 0} <span className="text-lg text-muted">/ {o.probeLimit}</span></div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface"><div className="h-full rounded-full bg-blue" style={{ width: `${pct}%` }} /></div>
          <p className="mt-3 text-sm text-muted">Offers the Vault has judged for this mandate. At the limit it is rotated under a new id.</p>
          <div className="mt-6 text-sm text-muted">Pinned token</div>
          <div className="mono mt-1 break-all text-xs text-muted">{o.meta?.deployment.token ?? "–"}</div>
        </Card>
      </div>

      <div className="mt-10 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-medium">Sessions</h2>
            <Link href="/negotiate" className="text-sm font-medium text-blue">New negotiation →</Link>
          </div>
          {o.sessions.length === 0 ? (
            <p className="mt-6 text-sm text-muted">No sessions yet. Start a negotiation to create one.</p>
          ) : (
            <table className="mt-4 w-full text-left text-sm">
              <thead className="text-muted"><tr><th className="py-2 font-normal">Session</th><th className="font-normal">Amount</th><th className="font-normal">Status</th><th className="font-normal">Created</th><th /></tr></thead>
              <tbody>
                {o.sessions.map((s) => (
                  <tr key={s.sessionId} className="border-t border-line">
                    <td className="mono py-3">{short(s.sessionId)}</td>
                    <td>{usdc(s.amount, dec)} USDC</td>
                    <td><Pill tone={s.status === "funded" ? "green" : s.status === "failed" ? "red" : "gray"}>{s.status}</Pill></td>
                    <td className="text-muted">{when(s.createdAt)}</td>
                    <td className="text-right"><Link href={`/receipts/${s.sessionId}`} className="text-blue">Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card>
          <h2 className="text-xl font-medium">Contracts · chain {o.chainId}</h2>
          <ul className="mt-4 space-y-4">
            {o.meta && (["registry", "escrow", "verifier"] as const).map((k) => (
              <li key={k}>
                <div className="text-sm capitalize">{k === "registry" ? "MandateRegistry" : k === "escrow" ? "SessionEscrow" : "SpendVerifier"}</div>
                {o.explorer ? (
                  <a href={`${o.explorer}/address/${o.meta!.deployment[k]}`} target="_blank" rel="noreferrer" className="mono break-all text-xs text-blue">{o.meta!.deployment[k]}</a>
                ) : (
                  <div className="mono break-all text-xs">{o.meta!.deployment[k]}</div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="mt-10 grid gap-6 lg:grid-cols-3">
        <Card>
          <h2 className="text-xl font-medium">The circuit</h2>
          {o.meta ? (
            <dl className="mt-4 space-y-2 text-sm">
              <Row k="Proof system" v={`${o.meta.circuit.protocol} on ${o.meta.circuit.curve}`} />
              <Row k="Public signals" v={String(o.meta.circuit.nPublic)} />
              <Row k="Variables" v={o.meta.circuit.variables?.toLocaleString() ?? "–"} />
              <Row k="Constraint domain" v={o.meta.circuit.domainSize ? `≤ ${o.meta.circuit.domainSize.toLocaleString()} (2^${Math.log2(o.meta.circuit.domainSize)})` : "–"} />
              <Row k="Mandate tree depth" v={String(o.meta.circuit.treeDepth)} />
              <Row k="Allow-list depth" v={String(o.meta.circuit.allowlistDepth)} />
              <Row k="Proving key" v={`${(o.meta.circuit.zkeyBytes / 1e6).toFixed(1)} MB`} />
            </dl>
          ) : <p className="mt-4 text-sm text-muted">Vault not reachable.</p>}
          <p className="mt-4 text-xs text-muted">Read from the built circuit, not typed in. The same verification key backs the on-chain SpendVerifier.</p>
        </Card>
        <Card className="lg:col-span-2">
          <h2 className="text-xl font-medium">Spend proofs</h2>
          {!proofs || proofs.length === 0 ? (
            <p className="mt-4 text-sm text-muted">No proofs yet. Each accepted deal makes one.</p>
          ) : (
            <table className="mt-4 w-full text-left text-sm">
              <thead className="text-muted"><tr><th className="py-2 font-normal">Session</th><th className="font-normal">Amount</th><th className="font-normal">Proving</th><th className="font-normal">Checked</th><th /></tr></thead>
              <tbody>
                {proofs.slice(0, 8).map((p) => (
                  <tr key={p.sessionId} className="border-t border-line">
                    <td className="mono py-3">{short(p.sessionId)}</td>
                    <td>{usdc(p.publicSignals.amount, dec)} USDC</td>
                    <td>{(p.provingMs / 1000).toFixed(1)} s</td>
                    <td><Pill tone={p.verifiedLocally ? "green" : "red"}>{p.verifiedLocally ? "verified" : "failed"}</Pill></td>
                    <td className="text-right"><Link href={`/receipts/${p.sessionId}`} className="text-blue">Inspect</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between gap-4"><dt className="text-muted">{k}</dt><dd className="text-right">{v}</dd></div>;
}

function Offline({ error }: { error: string }) {
  return (
    <div className="mx-auto max-w-[900px] px-6 py-16">
      <h1 className="display text-4xl">Backend not reachable</h1>
      <p className="mt-3 text-muted">{error}</p>
      <pre className="mono mt-6 rounded-lg bg-night p-4 text-sm text-white/80">{"cd backend\nnpm run dev      # local stack: anvil, contracts, Vault, sellers, coordinator, buyer agent\nSEALED_ENV=local npm --prefix ../frontend run dev"}</pre>
    </div>
  );
}

function SealForm({ o, busy, onSeal }: { o: Overview; busy: boolean; onSeal: (b: Record<string, unknown>) => void }) {
  const cats = Object.entries(o.meta?.categories ?? {});
  const [max, setMax] = useState("50");
  const [cap, setCap] = useState("20");
  const [days, setDays] = useState("7");
  const [picked, setPicked] = useState<number[]>(cats.map(([, id]) => id));
  const [sellers, setSellers] = useState<string[]>(o.sellers.map((s) => s.address));
  const toggle = <T,>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const input = "mt-1 w-full rounded-lg border border-line bg-white px-3 py-2";
  return (
    <div className="mt-4 space-y-5">
      <p className="text-sm text-muted">Seal a mandate. Only a commitment goes on chain; the amounts stay with the Vault.</p>
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="text-sm">Total budget (USDC)<input className={input} value={max} onChange={(e) => setMax(e.target.value)} inputMode="decimal" /></label>
        <label className="text-sm">Per-deal cap (USDC)<input className={input} value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" /></label>
        <label className="text-sm">Valid for (days)<input className={input} value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" /></label>
      </div>
      <div>
        <div className="text-sm text-muted">Allowed categories</div>
        <div className="mt-2 flex flex-wrap gap-2">
          {cats.map(([name, id]) => (
            <button key={id} type="button" onClick={() => setPicked(toggle(picked, id))} className={`rounded-full px-3 py-1.5 text-sm ${picked.includes(id) ? "bg-blue text-white" : "bg-surface text-muted"}`}>{CATEGORY_LABELS[name] ?? name}</button>
          ))}
        </div>
      </div>
      <div>
        <div className="text-sm text-muted">Allowed sellers</div>
        <div className="mt-2 flex flex-wrap gap-2">
          {o.sellers.map((s) => (
            <button key={s.address} type="button" onClick={() => setSellers(toggle(sellers, s.address))} className={`rounded-full px-3 py-1.5 text-sm ${sellers.includes(s.address) ? "bg-blue text-white" : "bg-surface text-muted"}`}>{s.name}</button>
          ))}
        </div>
      </div>
      <button className="btn btn-blue" disabled={busy || !o.services.vault} onClick={() => onSeal({ maxUsdc: Number(max), perDealUsdc: Number(cap), days: Number(days), categories: picked, sellers })}>
        {busy ? "Sealing on chain…" : "Seal mandate"}
      </button>
    </div>
  );
}
