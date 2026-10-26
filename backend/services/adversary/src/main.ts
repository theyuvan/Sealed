// CLI: simulated comparison, plus (optionally) the live Vault's recorded traces.
//   npx tsx services/adversary/src/main.ts [--runs 1000] [--seed 1]
//   VAULT_URL=... VAULT_ADMIN_TOKEN=... TRUE_CEILING=... npx tsx services/adversary/src/main.ts --live
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKEND_ROOT, loadEnv } from "@sealed/core";
import { evaluate, evaluateRecorded } from "./adversary.ts";

const env = loadEnv();
const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const result: Record<string, unknown> = { simulated: evaluate({ runs: Number(arg("--runs") ?? 1000), seed: Number(arg("--seed") ?? 1) }) };

if (process.argv.includes("--live")) {
  const r = await fetch(`${env.VAULT_URL ?? "http://127.0.0.1:7001"}/traces`, { headers: { authorization: `Bearer ${env.VAULT_ADMIN_TOKEN}` } });
  if (!r.ok) throw new Error(`vault /traces: HTTP ${r.status}`);
  if (!env.TRUE_CEILING) throw new Error("set TRUE_CEILING (min(maxAmount, perDealCap) in base units) to score live traces");
  result.live = evaluateRecorded((await r.json()) as never, BigInt(env.TRUE_CEILING));
}

console.log(JSON.stringify(result, null, 2));
const out = join(BACKEND_ROOT, "data", "adversary-report.json");
try {
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`wrote ${out}`);
} catch {}
