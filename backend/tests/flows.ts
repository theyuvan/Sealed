// Reusable test flows on top of harness.ts (real Vault, real proofs, real contracts).
import { createServer } from "node:net";
import { type Address, type Hex, keccak256, toHex } from "viem";
import { type PrivateKeyAccount } from "viem/accounts";
import { CATEGORIES, type SpendProofResponse, generateAuditorKey, openSessionArgs, seededRng, sessionEscrowAbi, signQuote } from "@sealed/core";
import { Vault, type VaultConfig } from "@sealed/vault";
import type { TestChain } from "./harness.ts";

export function testVault(tc: TestChain, over: Partial<VaultConfig> = {}): Vault {
  return new Vault({
    chainId: 31337,
    rpcUrl: tc.rpcUrl,
    deployment: tc.deployment,
    account: tc.keys.vault,
    buyer: tc.keys.buyer.address,
    auditorPublicKey: generateAuditorKey().publicKey,
    dbPath: ":memory:",
    globalProbeLimit: 40,
    perSellerNegotiations: 10,
    sellerCooldownMs: 0,
    responseDelayMs: 0,
    sessionSeconds: 3600,
    autoRotate: true,
    rng: seededRng(1),
    ...over,
  });
}

export async function sealDefault(vault: Vault, tc: TestChain, sellers: Address[], o: { max?: bigint; cap?: bigint } = {}) {
  const block = await tc.pub.getBlock();
  return vault.seal({
    maxAmount: o.max ?? 50_000_000n,
    perDealCap: o.cap ?? 20_000_000n,
    categories: [CATEGORIES["data.nav"], CATEGORIES["data.holders"], CATEGORIES["data.transfers"]],
    sellers,
    expiry: block.timestamp + 7n * 86_400n,
  });
}

/** Negotiates a deal the policy always accepts (well under theta*(1-alpha)), proves it, opens the session. */
export async function openSession(vault: Vault, tc: TestChain, seller: PrivateKeyAccount, o: { amount?: bigint; calls?: number; serviceId?: string } = {}): Promise<SpendProofResponse> {
  const amount = o.amount ?? 5_000_000n;
  const calls = o.calls ?? 5;
  const serviceId = o.serviceId ?? "nav-snapshot";
  const start = await vault.startNegotiation({ seller: seller.address, category: CATEGORIES["data.nav"], serviceId });
  if (start.status !== "open") throw new Error("negotiation declined");
  const q = await signQuote(seller, { serviceId, quote: amount, calls, sellerNonce: keccak256(toHex(`n-${Math.random()}`)) });
  const d = await vault.propose(start.negotiationId, q);
  if (d.decision !== "accept") throw new Error(`expected accept, got ${d.decision}`);
  const proof = (await vault.proveSpend(start.negotiationId, vault.expectedCart(start.negotiationId))) as SpendProofResponse;
  const w = tc.wallet(tc.keys.buyer);
  const hash = await w.writeContract({ address: tc.deployment.escrow, abi: sessionEscrowAbi, functionName: "open", args: openSessionArgs(proof), chain: w.chain, account: tc.keys.buyer });
  const rc = await tc.pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error("open reverted");
  return proof;
}

export async function sessionStatus(tc: TestChain, sessionId: Hex): Promise<number> {
  const s = await tc.pub.readContract({ address: tc.deployment.escrow, abi: sessionEscrowAbi, functionName: "getSession", args: [sessionId] });
  return s.status;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

export async function until(fn: () => Promise<boolean>, timeoutMs = 20_000, intervalMs = 100): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("timed out");
}
