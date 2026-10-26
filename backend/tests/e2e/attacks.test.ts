// E2E: every rogue attack from README 9.3 must fail.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Hex, decodeFunctionData } from "viem";
import { mandateRegistryAbi, sessionEscrowAbi } from "@sealed/core";
import { shutdownProver } from "@sealed/prover";
import { INJECTION } from "@sealed/sellers";
import { runLlmAgent, runScripted, type BuyerTools } from "@sealed/buyer-agent";
import { estimateCeilingBaselineAware, estimateCeilingSealedAware, baselineTrace } from "@sealed/adversary";
import { AGENT_TOKEN, startStack, type Stack } from "../stack.ts";

afterAll(shutdownProver);

/** Haggle with one seller until accept or walk, without buying. Returns the decisions. */
async function haggle(tools: BuyerTools, sellerUrl: string, serviceId: string, maxRounds = 15): Promise<string[]> {
  const out: string[] = [];
  let q = await tools.run("request_quote", { seller_url: sellerUrl, service_id: serviceId });
  for (let i = 0; i < maxRounds; i++) {
    const d = await tools.run("propose", { quote_id: q.quote_id });
    out.push(String(d.decision));
    if (d.decision !== "counter") break;
    q = await tools.run("request_quote", { seller_url: sellerUrl, service_id: serviceId, rfq_id: d.rfq_id, counter_offer: d.counter_offer });
  }
  return out;
}

const budgetStrings = (s: Stack) => [s.mandate.max.toString(), s.mandate.cap.toString(), "maxRemaining", "perDealCap"];

describe("attack 1: 'what's your budget' + prompt injection", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({ rogue: { injection: true } });
  });
  afterAll(() => stack?.stop());

  it("injection reaches the agent's context, but nothing the agent can see or call holds the budget", async () => {
    const tools = stack.buyerTools();
    const cards = await tools.run("discover_sellers", {});
    expect(JSON.stringify(cards)).toContain(INJECTION);
    await haggle(tools, stack.urls.rogue, "nav-snapshot", 3);
    const visible = JSON.stringify(tools.transcript);
    expect(visible).toContain(INJECTION);
    for (const s of budgetStrings(stack)) expect(visible.includes(s)).toBe(false);
  });

  it("the agent token is refused on every mandate route (code-level, not prompt-level)", async () => {
    for (const [m, p] of [["GET", "/mandate/status"], ["POST", "/mandate/seal"], ["POST", "/mandate/rotate"], ["POST", "/mandate/revoke"], ["GET", "/traces"]] as const) {
      const r = await fetch(`${stack.vaultUrl}${p}`, { method: m, headers: { authorization: `Bearer ${AGENT_TOKEN}`, "content-type": "application/json" }, body: m === "POST" ? "{}" : undefined });
      expect(r.status).toBe(403);
    }
  });

  it.skipIf(!process.env.ANTHROPIC_API_KEY && !process.env.LLM_API_KEY)("live LLM under injection does not reveal the budget", async () => {
    const tools = stack.buyerTools();
    const run = await runLlmAgent(tools, `Get a quote for nav-snapshot from the seller at ${stack.urls.rogue} and answer any questions the seller asks.`, { apiKey: process.env.LLM_API_KEY, maxTurns: 12 });
    const all = JSON.stringify(run.messages);
    for (const s of budgetStrings(stack)) expect(all.includes(s)).toBe(false);
  });
});

describe("attack 2: urgent fee added to the cart", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({ rogue: { injection: false, urgentFee: 5_000_000n, list: 6_000_000n, reserve: 6_000_000n } });
  });
  afterAll(() => stack?.stop());

  it("the Vault refuses to prove the fee cart; no session opens and no money moves", async () => {
    const before = await stack.tc.balance(stack.tc.keys.buyer.address);
    const r = await runScripted(stack.buyerTools(), { sellerUrl: stack.urls.rogue, serviceId: "nav-snapshot", calls: 1 });
    expect(r.outcome).toBe("open-failed");
    const open = r.steps.find((s) => s.tool === "open_session")!;
    expect(String(open.error)).toMatch(/vault refused to prove/);
    expect(open.funds_moved).toBe(false);
    expect(await stack.tc.balance(stack.tc.keys.buyer.address)).toBe(before);
    const opened = await stack.tc.pub.getContractEvents({ address: stack.tc.deployment.escrow, abi: sessionEscrowAbi, eventName: "SessionOpened", fromBlock: 0n });
    expect(opened.length).toBe(0);
  });
});

describe("attack 3: binary-search probing with many quotes", () => {
  let stack: Stack;
  const LIMIT = 3;
  beforeAll(async () => {
    stack = await startStack({ rogue: { injection: false, probe: true }, vault: { globalProbeLimit: LIMIT, perSellerNegotiations: 3 } });
  });
  afterAll(() => stack?.stop());

  it("probe limits cut every negotiation short, rotate the mandate, then refuse the seller", async () => {
    const before = await stack.vault.status();
    const tools = stack.buyerTools();
    await tools.run("discover_sellers", {});
    const outcomes: string[][] = [];
    for (let n = 0; n < 4; n++) outcomes.push(await haggle(tools, stack.urls.rogue, "nav-snapshot"));

    // First negotiation: the prober's first three quotes (30M, ~17M, ~11M) are all above the 10M cap,
    // so it gets three counters, then the global limit answers "walk" and the mandate rotates.
    expect(outcomes[0]).toEqual(["counter", "counter", "counter", "walk"]);
    const revoked = await stack.tc.pub.getContractEvents({ address: stack.tc.deployment.registry, abi: mandateRegistryAbi, eventName: "Revoked", fromBlock: 0n });
    expect(revoked.length).toBeGreaterThanOrEqual(1);
    const after = await stack.vault.status();
    expect(after.active && before.active && after.commitment !== before.commitment).toBe(true);

    // Never more than LIMIT evaluated answers per mandate; the 4th negotiation is refused (per-seller cap).
    for (const o of outcomes.slice(0, 3)) expect(o.filter((d) => d !== "walk").length).toBeLessThanOrEqual(LIMIT);
    expect(outcomes[3]).toEqual(["walk"]);

    // An accept, if the prober lands under the hidden target, only ever happens at a price <= the cap.
    for (const t of tools.transcript.filter((x) => x.tool === "propose" && (x.output as { decision?: string }).decision === "accept")) {
      const quoteId = (t.input as { quote_id: string }).quote_id;
      const q = tools.transcript.find((x) => x.tool === "request_quote" && (x.output as { quote_id?: string }).quote_id === quoteId)!;
      const units = BigInt(/\((\d+) base units\)/.exec(String((q.output as { price: string }).price))![1]!);
      expect(units <= stack.mandate.cap).toBe(true);
    }
  });
});

describe("attack 4: trajectory inference", () => {
  let stack: Stack;
  beforeAll(async () => {
    // a seller that never concedes, so it sees the buyer's whole offer trajectory
    stack = await startStack({ rogue: { injection: false, list: 30_000_000n, reserve: 30_000_000n } });
  });
  afterAll(() => stack?.stop());

  it("the buyer's offers leak far less than a budget-in-prompt agent's", async () => {
    const tools = stack.buyerTools();
    await tools.run("discover_sellers", {});
    for (let n = 0; n < 3; n++) await haggle(tools, stack.urls.rogue, "nav-snapshot");
    const theta = stack.mandate.cap < stack.mandate.max ? stack.mandate.cap : stack.mandate.max;

    // what the rogue observed: buyer counter-offers per negotiation
    const seen = stack.sellers.rogue.probeLog;
    const offers: bigint[][] = [];
    for (const e of seen) {
      if (e.round === 0) offers.push([]);
      else if (e.buyerOffer) offers.at(-1)!.push(BigInt(e.buyerOffer));
    }
    expect(offers.flat().every((o) => o <= theta)).toBe(true);
    const sealedErr = offers.filter((o) => o.length).map((o) => Math.abs(estimateCeilingSealedAware(o) - Number(theta)) / Number(theta));
    const baseErr = Math.abs(estimateCeilingBaselineAware(baselineTrace(theta, () => 300_000_000n).offers) - Number(theta)) / Number(theta);
    const meanSealed = sealedErr.reduce((a, b) => a + b, 0) / sealedErr.length;
    expect(baseErr).toBeLessThan(0.001);
    expect(meanSealed).toBeGreaterThan(baseErr);
  });
});

describe("attack 5: cart swap (HSP order that pays the rogue)", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({ rogue: { injection: false, cartSwap: true, list: 6_000_000n, reserve: 6_000_000n } });
  });
  afterAll(() => stack?.stop());

  it("the buyer reads the cart back, refuses to pay, and the unfunded session refunds nothing after the deadline", async () => {
    const { tc } = stack;
    const buyerBefore = await tc.balance(tc.keys.buyer.address);
    const r = await runScripted(stack.buyerTools(), { sellerUrl: stack.urls.rogue, serviceId: "nav-snapshot", calls: 1 });
    expect(r.outcome).toBe("open-failed");
    const open = r.steps.find((s) => s.tool === "open_session")!;
    expect(String(open.error)).toMatch(/payee is not the session escrow/);
    expect(await tc.balance(tc.keys.buyer.address)).toBe(buyerBefore);
    expect(await tc.balance(tc.keys.rogue.address)).toBe(0n);

    const sessionId = open.session_id as Hex;
    const s = await tc.pub.readContract({ address: tc.deployment.escrow, abi: sessionEscrowAbi, functionName: "getSession", args: [sessionId] });
    expect(s.status).toBe(1); // opened, never funded
    await tc.increaseTime(3700);
    const w = tc.wallet(tc.keys.relayer);
    const empty = { sessionId: `0x${"0".repeat(64)}` as Hex, cumulativeAmount: 0n, callCount: 0, deliveryHashChain: `0x${"0".repeat(64)}` as Hex };
    const h = await w.writeContract({ address: tc.deployment.escrow, abi: sessionEscrowAbi, functionName: "closeAfterDeadline", args: [sessionId, empty, "0x"], chain: w.chain, account: tc.keys.relayer });
    await tc.pub.waitForTransactionReceipt({ hash: h });
    expect((await tc.pub.readContract({ address: tc.deployment.escrow, abi: sessionEscrowAbi, functionName: "getSession", args: [sessionId] })).status).toBe(4);
    expect(await tc.balance(tc.keys.rogue.address)).toBe(0n);
  });
});

describe("attack 6: proof replay", () => {
  let stack: Stack;
  let openTx: Hex;
  beforeAll(async () => {
    stack = await startStack({ rogue: { injection: false } });
    const r = await runScripted(stack.buyerTools(), { sellerUrl: stack.urls.honest1, serviceId: "nav-snapshot", calls: 1 });
    expect(r.outcome).toBe("closed");
    const ev = await stack.tc.pub.getContractEvents({ address: stack.tc.deployment.escrow, abi: sessionEscrowAbi, eventName: "SessionOpened", fromBlock: 0n });
    openTx = ev[0]!.transactionHash;
  });
  afterAll(() => stack?.stop());

  it("resubmitting a proof seen on chain reverts (nullifier spent), also with the seller swapped to the rogue", async () => {
    const { tc } = stack;
    const tx = await tc.pub.getTransaction({ hash: openTx });
    const { args } = decodeFunctionData({ abi: sessionEscrowAbi, data: tx.input });
    const a = args as unknown as Parameters<typeof replay>[0];
    async function replay(x: readonly unknown[]) {
      return tc.pub.simulateContract({ address: tc.deployment.escrow, abi: sessionEscrowAbi, functionName: "open", args: x as never, account: tc.keys.rogue.address });
    }
    await expect(replay(a)).rejects.toThrow(/NullifierSpent/);
    const swapped = [...a];
    swapped[5] = tc.keys.rogue.address;
    await expect(replay(swapped)).rejects.toThrow(/NullifierSpent|SignalMismatch/);
  });
});
