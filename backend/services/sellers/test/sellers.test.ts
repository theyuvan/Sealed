import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Hex, keccak256, stringToHex } from "viem";
import { DELIVERY_SCHEMAS, canonicalJson, checkQuote, type SignedQuote } from "@sealed/core";
import { startChain, type TestChain } from "../../../tests/harness.ts";
import { INJECTION, buildSeller, buildProduct, pricedCatalog } from "../src/index.ts";

let tc: TestChain;
let honest: ReturnType<typeof buildSeller>;
let rogue: ReturnType<typeof buildSeller>;

const parseQuote = (q: any): SignedQuote => ({ ...q, quote: BigInt(q.quote) });

beforeAll(async () => {
  tc = await startChain();
  // some token activity for the data products
  await tc.mint(tc.keys.buyer.address, 50_000_000n);
  await tc.mint(tc.keys.seller2.address, 7_000_000n);
  const common = { chainId: 31337, rpcUrl: tc.rpcUrl, deployment: tc.deployment, coordinatorUrl: "http://127.0.0.1:1", dataAssets: [tc.deployment.token] };
  honest = buildSeller({ ...common, name: "honest-1", account: tc.keys.seller1, publicUrl: "http://honest", items: pricedCatalog({ listPrice: 12_000_000n, reservePrice: 6_000_000n }) });
  rogue = buildSeller({ ...common, name: "rogue", account: tc.keys.rogue, publicUrl: "http://rogue", items: pricedCatalog({ listPrice: 30_000_000n, reservePrice: 1_000_000n }), rogue: { injection: true, urgentFee: 5_000_000n, probe: true } });
});

afterAll(async () => {
  await tc?.stop();
});

async function post(app: ReturnType<typeof buildSeller>, url: string, payload: unknown) {
  const r = await app.inject({ method: "POST", url, payload: payload as object });
  return { status: r.statusCode, body: r.json() as any };
}

describe("sellers", () => {
  it("agent card lists services; the rogue's carries an injection", async () => {
    const card = (await honest.inject({ method: "GET", url: "/.well-known/agent.json" })).json();
    expect(card.address).toBe(tc.keys.seller1.address);
    expect(card.services.map((s: any) => s.id)).toEqual(["nav-snapshot", "holder-distribution", "recent-transfers"]);
    expect(card.notice).toBeUndefined();
    expect((await rogue.inject({ method: "GET", url: "/.well-known/agent.json" })).json().notice).toBe(INJECTION);
  });

  it("quotes are seller-signed commitments in multiples of the call count", async () => {
    const r = await post(honest, "/quote", { serviceId: "nav-snapshot" });
    const q = parseQuote(r.body.quote);
    expect(await checkQuote(q, tc.keys.seller1.address)).toBeNull();
    expect(q.quote).toBe(12_000_000n);
    expect(q.quote % BigInt(q.calls)).toBe(0n);
  });

  it("honest seller concedes toward its reserve, matches an offer above reserve, never goes below", async () => {
    const first = await post(honest, "/quote", { serviceId: "nav-snapshot" });
    const rfqId = first.body.rfqId;
    const second = parseQuote((await post(honest, "/quote", { serviceId: "nav-snapshot", rfqId, buyerOffer: "1000000" })).body.quote);
    expect(second.quote < 12_000_000n && second.quote >= 6_000_000n).toBe(true);
    const third = parseQuote((await post(honest, "/quote", { serviceId: "nav-snapshot", rfqId, buyerOffer: "8000000" })).body.quote);
    expect(third.quote).toBe(8_000_000n);
    for (let i = 0; i < 5; i++) {
      const q = parseQuote((await post(honest, "/quote", { serviceId: "nav-snapshot", rfqId, buyerOffer: "100" })).body.quote);
      expect(q.quote >= 6_000_000n).toBe(true);
    }
  });

  it("rogue probes by binary search between the buyer's best offer and its lowest countered quote", async () => {
    const r1 = await post(rogue, "/quote", { serviceId: "nav-snapshot" });
    expect(r1.body.message).toBe(INJECTION);
    const q2 = parseQuote((await post(rogue, "/quote", { serviceId: "nav-snapshot", rfqId: r1.body.rfqId, buyerOffer: "10000000" })).body.quote);
    expect(q2.quote).toBe(20_000_000n); // (10M + 30M) / 2
  });

  it("cart for an accepted quote; the rogue's includes an urgent fee", async () => {
    const hq = parseQuote((await post(honest, "/quote", { serviceId: "recent-transfers" })).body.quote);
    const hc = (await post(honest, "/cart", { quoteCommitment: hq.quoteCommitment })).body.cart;
    expect(hc.amount).toBe(hq.quote.toString());
    const rq = parseQuote((await post(rogue, "/quote", { serviceId: "recent-transfers" })).body.quote);
    const rc = (await post(rogue, "/cart", { quoteCommitment: rq.quoteCommitment })).body.cart;
    expect(BigInt(rc.amount)).toBe(rq.quote + 5_000_000n);
  });

  it("service without a session answers 402 with how to buy", async () => {
    const r = await honest.inject({ method: "GET", url: "/service/nav-snapshot" });
    expect(r.statusCode).toBe(402);
    expect(r.json().accepts[0].scheme).toBe("sealed-session");
  });

  it("refuses an HSP order for a session it does not own", async () => {
    const r = await post(honest, "/hsp/order", { sessionId: keccak256(stringToHex("nope")) });
    expect(r.status).toBe(400);
  });

  it("data products are built from live chain reads and match the delivery schemas", async () => {
    for (const id of ["nav-snapshot", "holder-distribution", "recent-transfers"]) {
      const p = await buildProduct(tc.pub, id, [tc.deployment.token]);
      const body = { service: id, sessionId: keccak256(stringToHex("s")) as Hex, call: 1, chainId: 31337, block: p.block.toString(), data: p.data };
      expect(DELIVERY_SCHEMAS[id]!.safeParse(JSON.parse(canonicalJson(body))).success).toBe(true);
    }
    const nav = await buildProduct(tc.pub, "nav-snapshot", [tc.deployment.token]);
    expect((nav.data[0] as any).totalSupply).toBe("57000000");
    const holders = await buildProduct(tc.pub, "holder-distribution", [tc.deployment.token]);
    expect((holders.data[0] as any).holders[0].address).toBe(tc.keys.buyer.address);
  });
});
