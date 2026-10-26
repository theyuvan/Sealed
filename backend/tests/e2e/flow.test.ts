// E2E: seal -> negotiate -> prove -> open -> fund via HSP -> vouchers -> close -> receipt
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Hex, zeroHash } from "viem";
import { mandateRegistryAbi, sessionEscrowAbi } from "@sealed/core";
import { shutdownProver } from "@sealed/prover";
import { runScripted } from "@sealed/buyer-agent";
import { startStack, type Stack } from "../stack.ts";

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack?.stop();
  await shutdownProver();
});

describe("e2e happy path", () => {
  it("buys 3 of 5 calls from honest-1: seller paid for 3, buyer refunded the rest, receipt links everything", async () => {
    const { tc } = stack;
    const sellerBefore = await tc.balance(tc.keys.seller1.address);
    const buyerBefore = await tc.balance(tc.keys.buyer.address);
    const statusBefore = (await stack.vault.status());

    const tools = stack.buyerTools();
    const r = await runScripted(tools, { sellerUrl: stack.urls.honest1, serviceId: "holder-distribution", calls: 3 });
    expect(r.outcome).toBe("closed");
    const sessionId = r.sessionId as Hex;

    // negotiation went through the Vault with at least one counter-offer
    expect(r.steps.some((s) => s.tool === "propose" && s.decision === "counter")).toBe(true);

    const s = await tc.pub.readContract({ address: tc.deployment.escrow, abi: sessionEscrowAbi, functionName: "getSession", args: [sessionId] });
    expect(s.status).toBe(3); // Closed
    const unit = s.cap / 5n;
    const receipt = r.receipt as { paid: string; refunded: string; nullifier: string; hspOrderId: string; deliveryHashChain: string; txs: Record<string, { tx: string } | null> };
    expect(BigInt(receipt.paid)).toBe(unit * 3n);
    expect(BigInt(receipt.paid) + BigInt(receipt.refunded)).toBe(s.cap);
    expect(receipt.nullifier).toBe(s.nullifier.toString());
    expect(receipt.hspOrderId).toBe(s.hspOrderId);
    expect(receipt.deliveryHashChain).not.toBe(zeroHash);
    for (const k of ["open", "hspTransfer", "markFunded", "close"]) expect(receipt.txs[k]?.tx).toMatch(/^0x[0-9a-f]{64}$/);

    expect((await tc.balance(tc.keys.seller1.address)) - sellerBefore).toBe(unit * 3n);
    expect(buyerBefore - (await tc.balance(tc.keys.buyer.address))).toBe(unit * 3n);
    expect(await tc.balance(tc.deployment.escrow)).toBe(0n);

    // the sealed budget dropped by the proven amount (the cap); only a new commitment is on chain
    const after = (await stack.vault.status());
    if (!after.active || !statusBefore.active) throw new Error("mandate inactive");
    expect(BigInt(statusBefore.remaining) - BigInt(after.remaining)).toBe(s.cap);
    const consumed = await tc.pub.getContractEvents({ address: tc.deployment.registry, abi: mandateRegistryAbi, eventName: "Consumed", fromBlock: 0n });
    expect(consumed.map((e) => e.args.nullifier)).toContain(s.nullifier);
  });

  it("a second deal spends from the new note", async () => {
    const r = await runScripted(stack.buyerTools(), { sellerUrl: stack.urls.honest2, serviceId: "recent-transfers", calls: 1 });
    expect(r.outcome).toBe("closed");
  });
});
