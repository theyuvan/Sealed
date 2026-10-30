import { config, coordinator, jsonError, seller, vault } from "@/lib/backend";

export const dynamic = "force-dynamic";

const up = (p: Promise<unknown>) =>
  p.then(
    () => true,
    () => false,
  );

/** Everything the dashboard needs in one call: service health, sellers, chain and circuit facts, masked mandate status. */
export async function GET() {
  try {
    const [vaultUp, coordUp, cards, meta, status, sessions] = await Promise.all([
      up(fetch(`${config.vaultUrl}/health`, { signal: AbortSignal.timeout(3000) })),
      up(coordinator("/health")),
      Promise.all(config.sellerUrls.map((url) => seller<Record<string, unknown>>(url, "/.well-known/agent.json").then((c) => ({ url, ...c }), () => null))),
      vault<Record<string, unknown>>("/meta").catch(() => null),
      vault<{ active: boolean; evaluations?: number; commitment?: string; expiry?: string; pendingSpend?: boolean }>("/mandate/status").catch(() => null),
      coordinator<unknown[]>("/sessions").catch(() => []),
    ]);
    const sellers = cards.filter(Boolean);
    return Response.json({
      chainId: config.chainId,
      explorer: config.explorer,
      hspMode: config.hspMode,
      decimals: config.decimals,
      probeLimit: config.probeLimit,
      services: { vault: vaultUp, coordinator: coordUp, sellers: sellers.length },
      sellers,
      meta,
      // the values of the mandate (remaining budget, per-deal cap) are not in this response: see /api/mandate?reveal=1
      mandate: status
        ? { active: status.active, evaluations: status.evaluations ?? 0, commitment: status.commitment ?? null, expiry: status.expiry ?? null, pendingSpend: status.pendingSpend ?? false }
        : null,
      sessions,
    });
  } catch (e) {
    return jsonError(e);
  }
}
