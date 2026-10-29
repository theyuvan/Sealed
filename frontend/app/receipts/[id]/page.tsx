import Link from "next/link";
import { notFound } from "next/navigation";
import { EXPLORER, receipts } from "@/lib/mock";
import { Card, Pill, Stat } from "@/components/Ui";

export function generateStaticParams() {
  return receipts.map((r) => ({ id: r.id }));
}

export default async function Receipt({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = receipts.find((x) => x.id === id);
  if (!r) notFound();

  const fields: [string, string][] = [
    ["Nullifier", r.nullifier],
    ["HSP order id", r.hspOrderId],
    ["Delivery hash chain", r.deliveryHashChain],
  ];

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="display text-4xl md:text-5xl">Receipt {r.id}</h1>
          <p className="mt-2 text-muted">{r.seller} · {r.service} · {r.closedAt}</p>
        </div>
        <Pill tone="green">Closed</Pill>
      </div>

      <Card className="mt-10">
        <div className="grid gap-6 sm:grid-cols-4">
          <Stat label="Paid" value={`${r.paid.toFixed(2)} USDC`} />
          <Stat label="Refunded" value={`${r.refunded.toFixed(2)} USDC`} />
          <Stat label="Calls" value={r.calls} />
          <Stat label="Escrowed" value={`${(r.paid + r.refunded).toFixed(2)} USDC`} />
        </div>
      </Card>

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <Card>
          <h2 className="text-xl font-medium">On-chain links</h2>
          <dl className="mt-4 space-y-4 text-sm">
            {fields.map(([k, v]) => (
              <div key={k}><dt className="text-muted">{k}</dt><dd className="mono break-all">{v}</dd></div>
            ))}
            <div><dt className="text-muted">Open tx</dt><dd><a className="mono text-blue" href={`${EXPLORER}/tx/${r.txOpen}`} target="_blank" rel="noreferrer">{r.txOpen}</a></dd></div>
            <div><dt className="text-muted">Close tx</dt><dd><a className="mono text-blue" href={`${EXPLORER}/tx/${r.txClose}`} target="_blank" rel="noreferrer">{r.txClose}</a></dd></div>
          </dl>
        </Card>
        <Card>
          <h2 className="text-xl font-medium">Deliveries</h2>
          <table className="mt-4 w-full text-left text-sm">
            <thead className="text-muted"><tr><th className="py-2 font-normal">#</th><th className="font-normal">Hash</th><th className="text-right font-normal">Voucher</th></tr></thead>
            <tbody>
              {r.deliveries.map((d) => (
                <tr key={d.n} className="border-t border-line"><td className="py-3">{d.n}</td><td className="mono">{d.hash}</td><td className="text-right">{d.amount.toFixed(2)}</td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
      <Link href="/dashboard" className="btn btn-ghost mt-8">Back to dashboard</Link>
    </div>
  );
}
