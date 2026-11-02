// Narrated demo of docs/DESIGN.md section 13, against a running stack (npm run dev, or npm start on testnet):
//   npm run demo                 pauses between steps (for a screen recording)
//   npm run demo -- --fast       no pauses
//   npm run demo -- --local      the local stack from `npm run dev` (.env.local)
//   E2E_SELLER_URL=http://127.0.0.1:7102 npm run demo      pick the honest seller
// Everything printed comes from the live services; nothing is scripted output.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKEND_ROOT, CATEGORIES, accountFromEnv, chainFor, envInt, loadEnv, requireEnv, rpcTransport } from "@sealed/core";
import { createPublicClient } from "viem";

const env = loadEnv();
const fast = process.argv.includes("--fast");
const vaultUrl = env.VAULT_URL ?? `http://127.0.0.1:${envInt("VAULT_PORT", 7001)}`;
const buyerUrl = env.BUYER_AGENT_URL ?? `http://127.0.0.1:${envInt("BUYER_AGENT_PORT", 7002)}`;
const coordUrl = env.COORDINATOR_URL ?? `http://127.0.0.1:${envInt("COORDINATOR_PORT", 7201)}`;
const sellerUrl = env.E2E_SELLER_URL ?? "http://127.0.0.1:7101";
const admin = requireEnv("VAULT_ADMIN_TOKEN");
const agent = requireEnv("VAULT_AGENT_TOKEN");
const dec = envInt("TOKEN_DECIMALS", 6);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pause = (ms: number) => (fast ? Promise.resolve() : sleep(ms));
const units = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** BigInt(dec) / 10n ** 6n;
const usdc = (u: string | bigint) => {
  const v = BigInt(u);
  const b = 10n ** BigInt(dec);
  return `${v / b}.${(v % b).toString().padStart(dec, "0").slice(0, 2)}`;
};
const step = async (t: string, title: string) => {
  console.log(`\n\x1b[1m[${t}] ${title}\x1b[0m`);
  await pause(1200);
};
const say = (s: string) => console.log(`      ${s}`);

async function http(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

// ---------------------------------------------------------------- 1. seal
await step("0:00", "The user seals a mandate: max 50, per deal 20, data products only, three sellers, 7 days");
let status = (await http("GET", `${vaultUrl}/mandate/status`, admin)).body;
if (!status.active) {
  const pub = createPublicClient({ chain: chainFor(envInt("CHAIN_ID", 31337), requireEnv("HSK_RPC_URL")), transport: rpcTransport() });
  const now = (await pub.getBlock()).timestamp;
  const sellers = await Promise.all(
    (env.SELLER_URLS ?? "http://127.0.0.1:7101,http://127.0.0.1:7102,http://127.0.0.1:7103").split(",").map(async (u) => ((await (await fetch(`${u.trim()}/.well-known/agent.json`)).json()) as { address: string }).address),
  );
  const r = await http("POST", `${vaultUrl}/mandate/seal`, admin, {
    maxAmount: units(50).toString(),
    perDealCap: units(20).toString(),
    categories: [CATEGORIES["data.nav"], CATEGORIES["data.holders"], CATEGORIES["data.transfers"]],
    sellers,
    expiry: (now + 7n * 86_400n).toString(),
  });
  if (r.status !== 200) throw new Error(`seal failed: ${JSON.stringify(r.body)}`);
  say(`sealed on chain, tx ${r.body.txHash}`);
  status = (await http("GET", `${vaultUrl}/mandate/status`, admin)).body;
} else {
  say("a mandate is already sealed; using it");
}
say(`all the chain sees: commitment ${String(status.commitment).slice(0, 18)}…  (no amounts, no seller list)`);

// ---------------------------------------------------------------- 2. the agent cannot reach the mandate
await step("0:30", "The buyer agent's token against the mandate routes");
for (const [m, p] of [["GET", "/mandate/status"], ["POST", "/mandate/seal"], ["POST", "/mandate/revoke"], ["GET", "/traces"]] as const) {
  const r = await http(m, `${vaultUrl}${p}`, agent, m === "POST" ? {} : undefined);
  say(`${m} ${p.padEnd(18)} -> HTTP ${r.status}${r.status === 403 ? "  (forbidden: the agent cannot read or change the mandate)" : "  <-- UNEXPECTED"}`);
}

// ---------------------------------------------------------------- 3. inference chart
await step("1:30", "Budget-inference error, budget-in-prompt agent vs Sealed (adversary evaluator)");
const reportPath = join(BACKEND_ROOT, "data", "adversary-report.json");
if (existsSync(reportPath)) {
  const s = JSON.parse(readFileSync(reportPath, "utf8")).simulated as Record<string, number>;
  const bar = (p: number) => "█".repeat(Math.max(1, Math.round(p * 100 * 2))).padEnd(30);
  say(`algorithm-aware adversary   baseline ${(s.baselineMapeAware! * 100).toFixed(1)}%  ${bar(s.baselineMapeAware!)}`);
  say(`                            Sealed   ${(s.sealedMapeAware! * 100).toFixed(1)}%  ${bar(s.sealedMapeAware!)}`);
  say(`generic trend estimator     baseline ${(s.baselineMape! * 100).toFixed(1)}%  ${bar(s.baselineMape!)}`);
  say(`                            Sealed   ${(s.sealedMapeGeneric! * 100).toFixed(1)}%  ${bar(s.sealedMapeGeneric!)}`);
  say("Sealed reduces behavioral leakage; it does not eliminate it.");
} else {
  say("no adversary report yet: run `npm run adversary` first");
}

// ---------------------------------------------------------------- 4. honest purchase
await step("2:00", `Honest seller ${sellerUrl}: negotiate, prove, open, fund through HSP, paid calls, close`);
const started = await http("POST", `${buyerUrl}/run`, undefined, { mode: "scripted", sellerUrl, serviceId: "nav-snapshot", calls: 3 });
if (!started.body.id) throw new Error(`could not start a run: ${JSON.stringify(started.body)}`);
let shown = 0;
let run: Record<string, any> = {};
for (let i = 0; i < 240; i++) {
  run = (await http("GET", `${buyerUrl}/runs/${started.body.id}`)).body;
  const t = (run.transcript ?? []) as { tool: string; output: Record<string, any> }[];
  for (; shown < t.length; shown++) {
    const o = t[shown]!.output;
    const line =
      o.error ? `ERROR ${o.error}` :
      t[shown]!.tool === "request_quote" ? `seller quotes ${o.price}` :
      t[shown]!.tool === "propose" ? (o.decision === "counter" ? `Vault counters ${o.counter_offer_display}` : `Vault decides: ${o.decision}`) :
      t[shown]!.tool === "open_session" ? `proof verified on chain, session ${String(o.session_id).slice(0, 12)}… ${o.status} (${o.price_per_call} per call)` :
      t[shown]!.tool === "call_service" ? (o.paid ? "delivery checked, voucher signed" : `delivery rejected, nothing paid`) :
      t[shown]!.tool === "close_session" ? "session closed" : "";
    say(`${t[shown]!.tool.padEnd(16)} ${line}`);
  }
  if (run.status !== "running") break;
  await sleep(1000);
}
if (run.status !== "done" || run.outcome !== "closed") throw new Error(`run did not finish: ${run.status} ${run.outcome ?? ""} ${run.error ?? ""}`);

// ---------------------------------------------------------------- 5. receipt and proof
await step("2:40", "The receipt, and the spend proof behind it");
const sid = run.sessionId as string;
const rc = await http("GET", `${coordUrl}/receipts/${sid}`);
const r = rc.body as Record<string, any>;
say(`paid to seller   ${usdc(r.paid)}   refunded ${usdc(r.refunded)}`);
say(`nullifier        ${r.nullifier}`);
say(`HSP order id     ${r.hspOrderId}   (${r.hspMode})`);
say(`delivery chain   ${r.deliveryHashChain}`);
for (const [k, v] of Object.entries(r.txs as Record<string, { tx: string; explorer: string | null } | null>)) if (v) say(`${k.padEnd(16)} ${v.explorer ?? v.tx}`);
const proofs = (await http("GET", `${vaultUrl}/proofs`, admin)).body as unknown as Record<string, any>[];
const p = proofs.find((x) => String(x.sessionId).toLowerCase() === sid.toLowerCase());
if (p) {
  say(`spend proof      Groth16, ${(p.provingMs / 1000).toFixed(1)} s, 12 public signals, the mandate is not among them`);
  const check = async (sig: string[]) => (await http("POST", `${vaultUrl}/circuit/verify`, admin, { proof: p.proof, publicSignals: sig })).body.valid;
  say(`verify           ${(await check(p.rawPublicSignals)) ? "valid" : "INVALID"}`);
  const amountIdx = Object.keys(p.publicSignals).indexOf("amount");
  const tampered = p.rawPublicSignals.map((s: string, i: number) => (i === amountIdx ? String(BigInt(s) + 1n) : s));
  say(`same proof, amount + 1   ${(await check(tampered)) ? "VALID (unexpected)" : "rejected: the proof is bound to the amount"}`);
}
console.log("\nDone.");
