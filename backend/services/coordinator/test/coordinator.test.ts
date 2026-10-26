import { createPublicKey } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Hex, keccak256, toHex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import {
  type HspConfig,
  HSP_DEFAULT_HEADERS,
  HSP_DEFAULT_PATHS,
  HspClient,
  buildPaymentMandate,
  checkCartForSession,
  merchantKey,
  readTokenDomain,
  sessionEscrowAbi,
  signWebhook,
  type SpendProofResponse,
} from "@sealed/core";
import { shutdownProver } from "@sealed/prover";
import { buildStandIn } from "@sealed/hsp-standin";
import { startChain, type TestChain } from "../../../tests/harness.ts";
import { freePort, openSession, sealDefault, sessionStatus, testVault, until } from "../../../tests/flows.ts";
import { Coordinator, buildCoordinatorServer, orderRequestMessage } from "../src/index.ts";

let tc: TestChain;
let hsp: HspConfig;
let coordinator: Coordinator;
let apps: { close(): Promise<unknown> }[] = [];
let coordUrl: string;
const vaultRef: { v?: ReturnType<typeof testVault> } = {};

async function requestOrder(sessionId: Hex, signer = tc.keys.seller1) {
  const sellerSignature = await signer.signMessage({ message: { raw: orderRequestMessage(sessionId) } });
  const r = await fetch(`${coordUrl}/hsp/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, sellerSignature, merchantLabel: "honest-1" }) });
  return { status: r.status, body: (await r.json()) as any };
}

/** What the buyer agent does: read the cart back from HSP, check it, sign EIP-3009, submit the payment mandate. */
async function buyerPays(p: SpendProofResponse, flowId: string) {
  const client = new HspClient(hsp);
  const cart = await client.cartByFlow(flowId);
  const err = checkCartForSession(cart, { chainId: 31337, token: tc.deployment.token, escrow: tc.deployment.escrow, amount: BigInt(p.amount), decimals: 6, sessionId: p.sessionId, x402Method: hsp.x402Method });
  if (err) throw new Error(err);
  const block = await tc.pub.getBlock();
  const pm = await buildPaymentMandate({ cfg: hsp, cart, payer: tc.keys.buyer, chainId: 31337, tokenDomain: await readTokenDomain(tc.pub, tc.deployment.token), sessionId: p.sessionId, amount: BigInt(p.amount), validBefore: block.timestamp + 600n });
  return client.payMandate(flowId, pm);
}

beforeAll(async () => {
  tc = await startChain();
  await tc.mint(tc.keys.buyer.address, 1_000_000_000n);
  const standinPort = await freePort();
  const coordPort = await freePort();
  coordUrl = `http://127.0.0.1:${coordPort}`;
  const mk = generatePrivateKey();
  hsp = {
    baseUrl: `http://127.0.0.1:${standinPort}`,
    payerBaseUrl: `http://127.0.0.1:${standinPort}`,
    appKey: "app-key",
    appSecret: "app-secret",
    merchantPrivateKey: mk,
    merchantName: "Sealed Test Merchant",
    webhookSecret: "webhook-secret",
    paths: HSP_DEFAULT_PATHS,
    headers: HSP_DEFAULT_HEADERS,
    jwtAudience: "HashkeyMerchant",
    x402Method: "https://www.x402.org/",
    networkName: "local",
    coin: "dUSDC",
    webhookEventIdField: "request_id",
    successStatuses: ["payment-successful"],
    failedStatuses: ["payment-failed"],
    localStandIn: true,
  };
  const standin = buildStandIn({
    chainId: 31337,
    rpcUrl: tc.rpcUrl,
    token: tc.deployment.token,
    decimals: 6,
    hsp,
    relayer: tc.keys.relayer,
    merchants: [{ name: hsp.merchantName, appKey: hsp.appKey, appSecret: hsp.appSecret, webhookSecret: hsp.webhookSecret, publicKey: createPublicKey(merchantKey(mk)), webhookUrl: `${coordUrl}/hsp/webhook` }],
    publicUrl: hsp.baseUrl,
    dbPath: ":memory:",
  });
  await standin.listen({ host: "127.0.0.1", port: standinPort });
  coordinator = new Coordinator({ chainId: 31337, rpcUrl: tc.rpcUrl, deployment: tc.deployment, account: tc.keys.coordinator, hsp, decimals: 6, dbPath: ":memory:" });
  const capp = buildCoordinatorServer(coordinator);
  await capp.listen({ host: "127.0.0.1", port: coordPort });
  apps = [standin, capp];

  vaultRef.v = testVault(tc);
  await sealDefault(vaultRef.v, tc, [tc.keys.seller1.address, tc.keys.seller2.address]);
});

afterAll(async () => {
  for (const a of apps) await a.close();
  await tc?.stop();
  await shutdownProver();
});

describe("coordinator", () => {
  let p: SpendProofResponse;
  let flowId: string;

  it("only the session's seller can request the HSP order", async () => {
    p = await openSession(vaultRef.v!, tc, tc.keys.seller1);
    const r = await requestOrder(p.sessionId, tc.keys.rogue);
    expect(r.status).toBe(403);
  });

  it("creates an HSP order whose cart pays the escrow exactly the session cap", async () => {
    const r = await requestOrder(p.sessionId);
    expect(r.status).toBe(200);
    flowId = r.body.flowId;
    const cart = await new HspClient(hsp).cartByFlow(flowId);
    expect(cart.contents.payment_request.method_data[0]!.data.pay_to.toLowerCase()).toBe(tc.deployment.escrow.toLowerCase());
    expect(cart.contents.payment_request.details.total.amount.value).toBe("5.00");
    // idempotent
    expect((await requestOrder(p.sessionId)).body.flowId).toBe(flowId);
  });

  it("buyer cart check rejects a cart that pays someone else or charges more", async () => {
    const cart = await new HspClient(hsp).cartByFlow(flowId);
    const e = { chainId: 31337, token: tc.deployment.token, escrow: tc.deployment.escrow, amount: BigInt(p.amount), decimals: 6, sessionId: p.sessionId, x402Method: hsp.x402Method };
    expect(checkCartForSession(cart, e)).toBeNull();
    const swapped = structuredClone(cart);
    swapped.contents.payment_request.method_data[0]!.data.pay_to = tc.keys.rogue.address;
    expect(checkCartForSession(swapped, e)).toMatch(/payee/);
    const fee = structuredClone(cart);
    fee.contents.payment_request.details.display_items.push({ label: "urgent compliance fee", amount: { currency: "USD", value: "2.00" } });
    fee.contents.payment_request.details.total.amount.value = "7.00";
    expect(checkCartForSession(fee, e)).toMatch(/total/);
    expect(checkCartForSession(cart, { ...e, sessionId: keccak256(toHex("other")) })).toMatch(/bound/);
  });

  it("does not mark funded on an HSP 'success' without the on-chain transfer", async () => {
    const r = (await coordinator.confirm(p.sessionId, { status: "payment-successful", cart_mandate_id: coordinator.order(p.sessionId)!.cart_mandate_id, payment_request_id: "x" })) as { funded: boolean; reason: string };
    expect(r.funded).toBe(false);
    expect(await sessionStatus(tc, p.sessionId)).toBe(1);
  });

  it("buyer pays through HSP; signed webhook -> chain checks -> markFunded", async () => {
    await buyerPays(p, flowId);
    await until(async () => (await sessionStatus(tc, p.sessionId)) === 2 && coordinator.order(p.sessionId)?.status === "funded");
    const o = coordinator.order(p.sessionId)!;
    expect(o.hsp_tx).toMatch(/^0x/);
  });

  it("webhooks: bad signature and stale timestamps are rejected; duplicates are ignored", async () => {
    const body = JSON.stringify({ request_id: "evt-1", status: "payment-successful", cart_mandate_id: "nope", payment_request_id: "nope" });
    const post = (sig: string) => fetch(`${coordUrl}/hsp/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-signature": sig }, body });
    expect((await post(signWebhook("wrong-secret", body))).status).toBe(401);
    expect((await post(signWebhook(hsp.webhookSecret, body, Math.floor(Date.now() / 1000) - 301))).status).toBe(401);
    expect((await post(signWebhook(hsp.webhookSecret, body))).status).toBe(200);
    expect(await (await post(signWebhook(hsp.webhookSecret, body))).json()).toMatchObject({ duplicate: true });
  });

  it("polling settles a payment when no webhook arrives", async () => {
    const p2 = await openSession(vaultRef.v!, tc, tc.keys.seller2);
    const sig = await tc.keys.seller2.signMessage({ message: { raw: orderRequestMessage(p2.sessionId) } });
    const order = await coordinator.createOrder(p2.sessionId, sig, "honest-2");
    // pay, but drop the webhook by confirming only through the poller
    await buyerPays(p2, order.flowId!);
    await coordinator.pollOnce();
    await until(async () => (await sessionStatus(tc, p2.sessionId)) === 2);
  });

  it("receipt links nullifier, HSP order and delivery chain after close", async () => {
    const s = await tc.pub.readContract({ address: tc.deployment.escrow, abi: sessionEscrowAbi, functionName: "getSession", args: [p.sessionId] });
    // no calls were made: settle after the deadline with no voucher, refunding everything
    await tc.increaseTime(3700);
    const anyone = tc.wallet(tc.keys.relayer);
    const h2 = await anyone.writeContract({
      address: tc.deployment.escrow,
      abi: sessionEscrowAbi,
      functionName: "closeAfterDeadline",
      args: [p.sessionId, { sessionId: "0x0000000000000000000000000000000000000000000000000000000000000000", cumulativeAmount: 0n, callCount: 0, deliveryHashChain: "0x0000000000000000000000000000000000000000000000000000000000000000" }, "0x"],
      chain: anyone.chain,
      account: tc.keys.relayer,
    });
    await tc.pub.waitForTransactionReceipt({ hash: h2 });
    const r = await (await fetch(`${coordUrl}/receipts/${p.sessionId}`)).json();
    expect(r.nullifier).toBe(s.nullifier.toString());
    expect(r.hspOrderId).toBe(coordinator.order(p.sessionId)!.hsp_order_id);
    expect(r.refunded).toBe(p.amount);
    expect(r.txs.open.tx).toMatch(/^0x/);
    expect(r.txs.hspTransfer.tx).toMatch(/^0x/);
    expect(r.hspMode).toBe("HSP local stand-in");
  });
});
