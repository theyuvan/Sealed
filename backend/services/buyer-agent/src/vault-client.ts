import type { DealCart, SignedQuote, SpendProofResponse } from "@sealed/core";

export type VaultDecision = { decision: "accept" | "walk" } | { decision: "counter"; offer: string };

export class VaultCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * The buyer agent's only way to reach the Vault. It holds the agent token (which the Vault accepts
 * only on these four routes) and has no method that reads or writes mandate values.
 */
export class VaultAgentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly agentToken: string,
  ) {}

  private async post<T>(path: "/negotiation/start" | "/negotiation/propose" | "/proof/spend" | "/voucher/sign", body: unknown): Promise<T> {
    const r = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.agentToken}` },
      body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      signal: AbortSignal.timeout(120_000),
    });
    const j = (await r.json().catch(() => ({}))) as T & { error?: string };
    if (!r.ok) throw new VaultCallError(j.error ?? `vault ${path} failed`, r.status);
    return j;
  }

  start(o: { seller: string; category: number; serviceId: string }) {
    return this.post<{ status: "open"; negotiationId: string } | { status: "declined" }>("/negotiation/start", o);
  }

  propose(negotiationId: string, quote: SignedQuote) {
    return this.post<VaultDecision>("/negotiation/propose", { negotiationId, quote });
  }

  proveSpend(negotiationId: string, cart: DealCart) {
    return this.post<SpendProofResponse>("/proof/spend", { negotiationId, cart });
  }

  signVoucher(sessionId: string, deliveryHash: string, price: string) {
    return this.post<{ voucher: { sessionId: string; cumulativeAmount: string; callCount: number; deliveryHashChain: string }; signature: string }>("/voucher/sign", {
      sessionId,
      deliveryHash,
      price,
    });
  }
}
