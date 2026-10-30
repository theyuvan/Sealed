import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Address, type Hex, keccak256, toHex, parseEventLogs } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  CATEGORIES,
  type DealCart,
  type SpendProofResponse,
  decryptAsAuditor,
  generateAuditorKey,
  mandateRegistryAbi,
  openSessionArgs,
  seededRng,
  sessionEscrowAbi,
  signQuote,
  syncRegistryTree,
} from "@sealed/core";
import { shutdownProver } from "@sealed/prover";
import { startChain, type TestChain } from "../../../tests/harness.ts";
import { Vault, buildVaultServer } from "../src/index.ts";

const ADMIN = "admin-token-test";
const AGENT = "agent-token-test";
const DELAY = 40;
const MAX = 50_000_000n;
const CAP = 20_000_000n;

let tc: TestChain;
let vault: Vault;
let app: ReturnType<typeof buildVaultServer>;
let auditor: ReturnType<typeof generateAuditorKey>;
const agentResponses: string[] = [];

async function call(token: string, method: "GET" | "POST", url: string, payload?: unknown) {
  const r = await app.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${token}` } });
  if (token === AGENT) agentResponses.push(r.body);
  return { status: r.statusCode, body: r.json() as any };
}

const seller1 = () => tc.keys.seller1;

async function quote(serviceId: string, amount: bigint, calls = 5, signer = seller1()) {
  return signQuote(signer, { serviceId, quote: amount, calls, sellerNonce: keccak256(toHex(`${Math.random()}`)) });
}

function wire(q: Awaited<ReturnType<typeof quote>>) {
  return { ...q, quote: q.quote.toString() };
}

beforeAll(async () => {
  tc = await startChain();
  auditor = generateAuditorKey();
  vault = new Vault({
    chainId: 31337,
    rpcUrl: tc.rpcUrl,
    deployment: tc.deployment,
    account: tc.keys.vault,
    buyer: tc.keys.buyer.address,
    auditorPublicKey: auditor.publicKey,
    dbPath: ":memory:",
    globalProbeLimit: 12,
    perSellerNegotiations: 3,
    sellerCooldownMs: 0,
    responseDelayMs: DELAY,
    sessionSeconds: 3600,
    autoRotate: true,
    rng: seededRng(42),
  });
  app = buildVaultServer(vault, { adminToken: ADMIN, agentToken: AGENT, responseDelayMs: DELAY });
  await tc.mint(tc.keys.buyer.address, 1_000_000_000n);
});

afterAll(async () => {
  await tc?.stop();
  await shutdownProver();
});

describe("vault access control", () => {
  it("agent token cannot reach mandate routes; admin cannot use agent routes; no token is 401", async () => {
    for (const [m, u] of [["POST", "/mandate/seal"], ["GET", "/mandate/status"], ["POST", "/mandate/revoke"], ["POST", "/mandate/rotate"], ["GET", "/traces"]] as const) {
      expect((await call(AGENT, m, u, {})).status).toBe(403);
    }
    expect((await call(ADMIN, "POST", "/negotiation/start", {})).status).toBe(403);
    expect((await app.inject({ method: "POST", url: "/negotiation/start", payload: {} })).statusCode).toBe(401);
  });
});

describe("registry tree sync", () => {
  it("sees a commitment sealed after the client cached the chain head (regression)", async () => {
    const v = new Vault({ ...vault.cfg, dbPath: ":memory:" });
    await v.pub.getBlockNumber(); // primes viem's block-number cache on the sync client
    const w = tc.wallet(tc.keys.rogue); // seal through a different client so the cache stays stale
    const hash = await w.writeContract({ address: tc.deployment.registry, abi: mandateRegistryAbi, functionName: "seal", args: [777n, "0x"], chain: w.chain, account: tc.keys.rogue });
    // poll quickly: viem's waitForTransactionReceipt can take a full 4s poll, which would expire the cache
    for (;;) {
      if (await tc.pub.getTransactionReceipt({ hash }).catch(() => null)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const tree = await syncRegistryTree(v.pub, tc.deployment.registry, 0n);
    expect(tree.indexOf(777n)).toBeGreaterThanOrEqual(0);
  });
});

describe("vault lifecycle", () => {
  let negotiationId: string;
  let accepted: Awaited<ReturnType<typeof quote>>;
  let proof: SpendProofResponse;

  it("seals a mandate: only a commitment goes on chain, rules are encrypted to the auditor", async () => {
    const block = await tc.pub.getBlock();
    const r = await call(ADMIN, "POST", "/mandate/seal", {
      maxAmount: MAX.toString(),
      perDealCap: CAP.toString(),
      categories: [CATEGORIES["data.nav"], CATEGORIES["data.holders"]],
      sellers: [tc.keys.seller1.address, tc.keys.rogue.address],
      expiry: (block.timestamp + 86_400n).toString(),
    });
    expect(r.status).toBe(200);
    const rc = await tc.pub.getTransactionReceipt({ hash: r.body.txHash });
    const [ev] = parseEventLogs({ abi: mandateRegistryAbi, logs: rc.logs, eventName: "Sealed" });
    expect(ev!.args.commitment.toString()).toBe(r.body.commitment);
    const plain = JSON.parse(decryptAsAuditor(auditor.privateKey, ev!.args.auditorCiphertext));
    expect(plain.rules.maxRemaining).toBe(MAX.toString());
    // nothing in the tx calldata reveals the budget in clear
    const tx = await tc.pub.getTransaction({ hash: r.body.txHash });
    expect(tx.input.includes(MAX.toString(16).padStart(64, "0"))).toBe(false);
  });

  it("declines sellers and categories outside the mandate, without a reason", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    expect((await call(AGENT, "POST", "/negotiation/start", { seller: stranger, category: 1, serviceId: "nav" })).body).toEqual({ status: "declined" });
    expect((await call(AGENT, "POST", "/negotiation/start", { seller: seller1().address, category: 3, serviceId: "nav" })).body).toEqual({ status: "declined" });
  });

  it("rejects unsigned or tampered quotes without evaluating them", async () => {
    const r = await call(AGENT, "POST", "/negotiation/start", { seller: seller1().address, category: 1, serviceId: "nav" });
    expect(r.body.status).toBe("open");
    negotiationId = r.body.negotiationId;
    const q = wire(await quote("nav", 40_000_000n));
    expect((await call(AGENT, "POST", "/negotiation/propose", { negotiationId, quote: { ...q, quote: "30000000" } })).status).toBe(400);
    const other = wire(await quote("nav", 40_000_000n, 5, tc.keys.rogue));
    expect((await call(AGENT, "POST", "/negotiation/propose", { negotiationId, quote: other })).status).toBe(400);
    expect((await vault.status())).toMatchObject({ evaluations: 0 });
  });

  it("counters high quotes with offers below the hidden target, after a fixed delay", async () => {
    const t0 = Date.now();
    const r = await call(AGENT, "POST", "/negotiation/propose", { negotiationId, quote: wire(await quote("nav", 40_000_000n)) });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(DELAY - 5);
    expect(r.body.decision).toBe("counter");
    expect(Object.keys(r.body).sort()).toEqual(["decision", "offer"]);
    expect(BigInt(r.body.offer) <= CAP).toBe(true);
  });

  it("accepts a quote at or below the hidden target", async () => {
    accepted = await quote("nav", 10_000_000n); // below theta*(1-alpha) = 15M, so always below T
    const r = await call(AGENT, "POST", "/negotiation/propose", { negotiationId, quote: wire(accepted) });
    expect(r.body).toEqual({ decision: "accept" });
  });

  it("refuses to prove a cart with an extra fee (urgent fee attack)", async () => {
    const cart = vault.expectedCart(negotiationId);
    const withFee: DealCart = { ...cart, amount: (BigInt(cart.amount) + 5_000_000n).toString() };
    const r = await call(AGENT, "POST", "/proof/spend", { negotiationId, cart: withFee });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/does not match/);
  });

  it("proves the accepted cart; the proof opens a session on chain", async () => {
    const cart = vault.expectedCart(negotiationId);
    const r = await call(AGENT, "POST", "/proof/spend", { negotiationId, cart });
    expect(r.status).toBe(200);
    proof = r.body;
    const buyerWallet = tc.wallet(tc.keys.buyer);
    const hash = await buyerWallet.writeContract({ address: tc.deployment.escrow, abi: sessionEscrowAbi, functionName: "open", args: openSessionArgs(proof), chain: buyerWallet.chain, account: tc.keys.buyer });
    expect((await tc.pub.waitForTransactionReceipt({ hash })).status).toBe("success");
    const s = await tc.pub.readContract({ address: tc.deployment.escrow, abi: sessionEscrowAbi, functionName: "getSession", args: [proof.sessionId] });
    expect(s.cap).toBe(10_000_000n);
    expect(s.status).toBe(1);
  });

  it("owner view: the proof, its named public signals and the circuit are readable by the admin only, and the proof verifies", async () => {
    expect((await call(AGENT, "GET", "/proofs")).status).toBe(403);
    expect((await call(AGENT, "GET", "/meta")).status).toBe(403);
    const list = (await call(ADMIN, "GET", "/proofs")).body as any[];
    const p = list.find((x) => x.sessionId === proof.sessionId.toLowerCase());
    expect(p.verifiedLocally).toBe(true);
    expect(p.provingMs).toBeGreaterThan(0);
    expect(Object.keys(p.publicSignals)).toEqual(["root", "nullifier", "newCommitment", "revTag", "amount", "category", "seller", "token", "cartHash", "sessionId", "now", "sessionKeyHash"]);
    expect(p.publicSignals.amount).toBe("10000000");
    // nothing about the remaining budget or the cap is in what the owner view lists for a proof
    expect(JSON.stringify(p)).not.toMatch(/maxRemaining|perDealCap/);
    const ok = (await call(ADMIN, "POST", "/circuit/verify", { proof: p.proof, publicSignals: p.rawPublicSignals })).body;
    expect(ok.valid).toBe(true);
    const tampered = p.rawPublicSignals.map((x: string, i: number) => (i === 4 ? "1" : x)); // a different amount
    expect((await call(ADMIN, "POST", "/circuit/verify", { proof: p.proof, publicSignals: tampered })).body.valid).toBe(false);
    const meta = (await call(ADMIN, "GET", "/meta")).body;
    expect(meta.circuit).toMatchObject({ protocol: "groth16", nPublic: 12 });
    expect(meta.circuit.domainSize).toBeGreaterThan(1000);
  });

  it("only one proof per negotiation", async () => {
    const r = await call(AGENT, "POST", "/proof/spend", { negotiationId, cart: vault.expectedCart(negotiationId) });
    expect(r.status).toBe(400);
  });

  it("vouchers: refused before funding, then cumulative at the agreed unit price, capped at the call count", async () => {
    const dh = (i: number) => keccak256(toHex(`delivery-${i}`));
    expect((await call(AGENT, "POST", "/voucher/sign", { sessionId: proof.sessionId, deliveryHash: dh(0), price: "2000000" })).status).toBe(400);
    await tc.payWithAuthorization({ from: tc.keys.buyer, to: tc.deployment.escrow, value: 10_000_000n, nonce: proof.sessionId });
    await tc.markFunded(proof.sessionId, keccak256(toHex("order")));

    expect((await call(AGENT, "POST", "/voucher/sign", { sessionId: proof.sessionId, deliveryHash: dh(0), price: "3000000" })).status).toBe(400);
    let last: any;
    for (let i = 1; i <= 3; i++) {
      const r = await call(AGENT, "POST", "/voucher/sign", { sessionId: proof.sessionId, deliveryHash: dh(i), price: "2000000" });
      expect(r.status).toBe(200);
      last = r.body;
    }
    expect(last.voucher.cumulativeAmount).toBe("6000000");
    expect(last.voucher.callCount).toBe(3);

    // the seller can claim it on chain; the rest is refunded
    const sellerWallet = tc.wallet(seller1());
    const v = last.voucher;
    const before = await tc.balance(tc.keys.buyer.address);
    const hash = await sellerWallet.writeContract({
      address: tc.deployment.escrow,
      abi: sessionEscrowAbi,
      functionName: "close",
      args: [proof.sessionId, { sessionId: v.sessionId, cumulativeAmount: BigInt(v.cumulativeAmount), callCount: v.callCount, deliveryHashChain: v.deliveryHashChain }, last.signature],
      chain: sellerWallet.chain,
      account: seller1(),
    });
    expect((await tc.pub.waitForTransactionReceipt({ hash })).status).toBe("success");
    expect(await tc.balance(seller1().address)).toBe(6_000_000n);
    expect((await tc.balance(tc.keys.buyer.address)) - before).toBe(4_000_000n);
  });

  it("advances the budget note after the spend", async () => {
    await call(AGENT, "POST", "/negotiation/start", { seller: tc.keys.rogue.address, category: 1, serviceId: "nav" });
    expect((await vault.status())).toMatchObject({ remaining: (MAX - 10_000_000n).toString(), pendingSpend: false });
  });

  it("per-seller negotiation cap", async () => {
    // seller1 has used 1 negotiation; rogue 1. Two more for seller1 are allowed, then declined.
    expect((await call(AGENT, "POST", "/negotiation/start", { seller: seller1().address, category: 1, serviceId: "nav" })).body.status).toBe("open");
    expect((await call(AGENT, "POST", "/negotiation/start", { seller: seller1().address, category: 1, serviceId: "nav" })).body.status).toBe("open");
    expect((await call(AGENT, "POST", "/negotiation/start", { seller: seller1().address, category: 1, serviceId: "nav" })).body).toEqual({ status: "declined" });
  });

  it("global evaluation limit ends negotiations and rotates the mandate on chain", async () => {
    const v2 = new Vault({ ...vault.cfg, dbPath: ":memory:", globalProbeLimit: 3, rng: seededRng(7) });
    const app2 = buildVaultServer(v2, { adminToken: ADMIN, agentToken: AGENT, responseDelayMs: 0 });
    const block = await tc.pub.getBlock();
    await v2.seal({ maxAmount: MAX, perDealCap: CAP, categories: [1], sellers: [tc.keys.rogue.address], expiry: block.timestamp + 86_400n });
    const before = (await v2.status());
    const post = async (url: string, payload: unknown) => (await app2.inject({ method: "POST", url, payload: payload as object, headers: { authorization: `Bearer ${AGENT}` } })).json() as any;
    const { negotiationId: nid } = await post("/negotiation/start", { seller: tc.keys.rogue.address, category: 1, serviceId: "nav" });
    const decisions: string[] = [];
    for (let i = 0; i < 4; i++) decisions.push((await post("/negotiation/propose", { negotiationId: nid, quote: wire(await quote("nav", 19_999_995n, 5, tc.keys.rogue)) })).decision);
    // policy walk-away round is >= 4, so the 4th answer is the global limit
    expect(decisions).toEqual(["counter", "counter", "counter", "walk"]);
    const after = (await v2.status());
    expect(after.active && before.active).toBe(true);
    if (!after.active || !before.active) return;
    expect(after.commitment).not.toBe(before.commitment);
    expect(after.remaining).toBe(before.remaining);
    expect(after.evaluations).toBe(0);
    const revoked = await tc.pub.getContractEvents({ address: tc.deployment.registry, abi: mandateRegistryAbi, eventName: "Revoked", fromBlock: block.number });
    expect(revoked.length).toBeGreaterThanOrEqual(1);
    // a fresh negotiation under the new mandate is possible again
    expect((await post("/negotiation/start", { seller: tc.keys.rogue.address, category: 1, serviceId: "nav" })).status).toBe("open");
  });

  it("agent-visible responses never contain mandate values or fields", () => {
    const all = agentResponses.join("\n");
    for (const secret of [MAX.toString(), CAP.toString(), "maxRemaining", "perDealCap", "expiry", "ownerSecret", "salt", "target"]) {
      expect(all.includes(secret)).toBe(false);
    }
  });
});
