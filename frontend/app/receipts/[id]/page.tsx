"use client";
import { use, useState } from "react";
import Link from "next/link";
import { Card, Pill, Stat } from "@/components/Ui";
import { api, usePoll, type ProofRecord } from "@/lib/api";
import { short, usdc, when } from "@/lib/format";

type Tx = { tx: string; explorer: string | null } | null;
type Receipt = {
  sessionId: string; nullifier: string; hspOrderId: string; hspCartMandateId: string | null; hspPaymentRequestId: string | null;
  paid: string; refunded: string; deliveryHashChain: string; hspMode: string;
  txs: { open: Tx; hspTransfer: Tx; markFunded: Tx; close: Tx };
  error?: string;
};
type Payload = { receipt: Receipt; proof: ProofRecord | null };

export default function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error } = usePoll<Payload>(`/api/receipts/${id}`, 6000);
  const [check, setCheck] = useState<{ label: string; valid: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  if (error && !data) return <Shell id={id}><p className="mt-6 rounded-lg bg-[#fbe9ea] p-3 text-sm text-down">{error}</p></Shell>;
  if (!data) return <Shell id={id}><p className="mt-6 text-muted">Loading…</p></Shell>;
  const { receipt: r, proof: p } = data;
  const closed = !r.error;

  const verify = async (label: string, signals: string[]) => {
    if (!p) return;
    setBusy(true);
    try {
      const res = await api<{ valid: boolean }>("/api/verify", { method: "POST", body: JSON.stringify({ proof: p.proof, publicSignals: signals }) });
      setCheck({ label, valid: res.valid });
    } catch (e) {
      setCheck({ label: `${label}: ${(e as Error).message}`, valid: false });
    } finally {
      setBusy(false);
    }
  };
  const amountIdx = p ? Object.keys(p.publicSignals).indexOf("amount") : -1;

  return (
    <Shell id={id} pill={<Pill tone={closed ? "green" : "gray"}>{closed ? "Closed" : "Not closed yet"}</Pill>}>
      {closed ? (
        <Card className="mt-10">
          <div className="grid gap-6 sm:grid-cols-3">
            <Stat label="Paid to seller" value={`${usdc(r.paid)} USDC`} />
            <Stat label="Refunded" value={`${usdc(r.refunded)} USDC`} />
            <Stat label="Escrowed" value={`${usdc(BigInt(r.paid) + BigInt(r.refunded))} USDC`} />
          </div>
        </Card>
      ) : (
        <Card className="mt-10"><p className="text-sm text-muted">{r.error}. The receipt is emitted when the seller closes the session on chain. The proof below already exists.</p></Card>
      )}

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        {closed && (
          <Card>
            <h2 className="text-xl font-medium">On-chain links</h2>
            <dl className="mt-4 space-y-4 text-sm">
              {([["Nullifier", r.nullifier], ["HSP order id", r.hspOrderId], ["HSP cart mandate", r.hspCartMandateId ?? "–"], ["Delivery hash chain", r.deliveryHashChain]] as const).map(([k, v]) => (
                <div key={k}><dt className="text-muted">{k}</dt><dd className="mono break-all">{v}</dd></div>
              ))}
              {([["Open (proof verified)", r.txs.open], ["HSP transfer", r.txs.hspTransfer], ["Mark funded", r.txs.markFunded], ["Close", r.txs.close]] as const).map(([k, t]) => (
                <div key={k}><dt className="text-muted">{k}</dt><dd>{t ? (t.explorer ? <a className="mono break-all text-blue" href={t.explorer} target="_blank" rel="noreferrer">{short(t.tx, 14, 10)}</a> : <span className="mono break-all">{t.tx}</span>) : "–"}</dd></div>
              ))}
              <div><dt className="text-muted">Payment rail</dt><dd>{r.hspMode}</dd></div>
            </dl>
          </Card>
        )}

        <Card className={closed ? "" : "md:col-span-2"}>
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-medium">Spend proof</h2>
            {p && <Pill tone={p.verifiedLocally ? "green" : "red"}>{p.verifiedLocally ? "verified" : "failed"}</Pill>}
          </div>
          {!p ? (
            <p className="mt-4 text-sm text-muted">This Vault has no proof for this session.</p>
          ) : (
            <>
              <p className="mt-2 text-sm text-muted">Groth16, generated in {(p.provingMs / 1000).toFixed(1)} s, made {when(p.createdAt)}. These are the 12 public signals the chain sees; the mandate itself is not among them.</p>
              <table className="mt-4 w-full text-left text-sm">
                <tbody>
                  {Object.entries(p.publicSignals).map(([k, v]) => (
                    <tr key={k} className="border-t border-line">
                      <td className="py-2 pr-4 text-muted">{k}</td>
                      <td className="mono break-all">{k === "amount" ? `${usdc(v)} USDC (${v})` : short(v, 14, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-5 flex flex-wrap gap-3">
                <button className="btn btn-ghost !py-2.5" disabled={busy} onClick={() => verify("Proof checks out against the verification key", p.rawPublicSignals)}>Verify proof</button>
                <button className="btn btn-ghost !py-2.5" disabled={busy} onClick={() => verify("Same proof with the amount changed", p.rawPublicSignals.map((s, i) => (i === amountIdx ? String(BigInt(s) + 1n) : s)))}>Try with amount + 1</button>
              </div>
              {check && <div className={`mt-3 rounded-lg p-3 text-sm ${check.valid ? "bg-[#e6f6ee] text-up" : "bg-[#fbe9ea] text-down"}`}>{check.label}: {check.valid ? "valid" : "rejected"}</div>}
              <p className="mt-3 text-xs text-muted">The second button shows the binding: change any public signal and the same proof no longer verifies, which is why a swapped cart or amount reverts on chain.</p>
            </>
          )}
        </Card>
      </div>
    </Shell>
  );
}

function Shell({ id, pill, children }: { id: string; pill?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-[1100px] px-6 py-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="display text-4xl md:text-5xl">Session {short(id, 10, 8)}</h1>
          <p className="mono mt-2 break-all text-xs text-muted">{id}</p>
        </div>
        {pill}
      </div>
      {children}
      <Link href="/dashboard" className="btn btn-ghost mt-8">Back to dashboard</Link>
    </div>
  );
}
