"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Card, Pill } from "@/components/Ui";
import { usePoll, type Overview, type SessionRow } from "@/lib/api";
import { short, usdc, when } from "@/lib/format";

/** The coordinator's status is the HSP funding status and never becomes "closed", so ask for the on-chain receipt. */
function Settlement({ id }: { id: string }) {
  const [closed, setClosed] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/receipts/${id}`)
      .then((r) => r.json())
      .then((d: { receipt?: { error?: string } }) => live && setClosed(!!d.receipt && !d.receipt.error))
      .catch(() => live && setClosed(null));
    return () => { live = false; };
  }, [id]);
  return <Pill tone={closed ? "green" : "gray"}>{closed === null ? "…" : closed ? "closed" : "open"}</Pill>;
}

export default function Receipts() {
  const { data, error } = usePoll<SessionRow[]>("/api/sessions", 5000);
  const { data: o } = usePoll<Overview>("/api/overview", 30000);
  const dec = o?.decimals ?? 6;
  return (
    <div className="mx-auto max-w-[1100px] px-6 py-12">
      <h1 className="display text-4xl md:text-5xl">Sessions and receipts</h1>
      <p className="mt-2 text-muted">Every session the coordinator has an HSP order for, newest first.</p>
      <Card className="mt-10">
        {error && !data ? (
          <p className="text-sm text-down">{error}</p>
        ) : !data || data.length === 0 ? (
          <p className="text-sm text-muted">No sessions yet. <Link href="/negotiate" className="text-blue">Start a negotiation</Link>.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-muted"><tr><th className="py-2 font-normal">Session</th><th className="font-normal">Seller</th><th className="font-normal">Amount</th><th className="font-normal">Funding</th><th className="font-normal">Settlement</th><th className="font-normal">Created</th><th /></tr></thead>
            <tbody>
              {data.map((s) => (
                <tr key={s.sessionId} className="border-t border-line">
                  <td className="mono py-3">{short(s.sessionId)}</td>
                  <td className="mono">{short(s.seller, 6, 4)}</td>
                  <td>{usdc(s.amount, dec)} USDC</td>
                  <td><Pill tone={s.status === "funded" ? "green" : s.status === "failed" ? "red" : "gray"}>{s.status}</Pill></td>
                  <td><Settlement id={s.sessionId} /></td>
                  <td className="text-muted">{when(s.createdAt)}</td>
                  <td className="text-right"><Link href={`/receipts/${s.sessionId}`} className="text-blue">Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
