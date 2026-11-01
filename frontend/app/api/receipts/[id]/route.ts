import { config, coordinator, jsonError, vault } from "@/lib/backend";

export const dynamic = "force-dynamic";

/** The on-chain receipt for a session (coordinator) together with the spend proof the Vault made for it. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = (await params).id;
    if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new Error("session id must be 0x + 64 hex characters");
    const [receipt, proofs] = await Promise.all([
      coordinator<Record<string, unknown>>(`/receipts/${id}`).catch((e: Error) => ({ error: e.message })),
      vault<Record<string, unknown>[]>("/proofs").catch(() => []),
    ]);
    // build explorer links from our configured base so EXPLORER_URL applies everywhere
    const txs = (receipt as { txs?: Record<string, { tx: string } | null> }).txs;
    if (txs) for (const k of Object.keys(txs)) { const t = txs[k]; if (t) (t as Record<string, unknown>).explorer = config.explorer ? `${config.explorer}/tx/${t.tx}` : null; }
    return Response.json({ receipt, proof: proofs.find((p) => String(p.sessionId).toLowerCase() === id.toLowerCase()) ?? null });
  } catch (e) {
    return jsonError(e);
  }
}
