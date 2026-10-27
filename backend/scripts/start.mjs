// Starts all services against the chain configured in backend/.env (testnet or mainnet).
// Unlike `npm run dev` it does not start anvil or deploy: run `npm run deploy` first.
// The HSP local stand-in is started only when HSP_LOCAL_STANDIN=1 (never on mainnet).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import { REPO, ROOT, start, waitFor } from "./lib.mjs";

config({ path: join(ROOT, ".env"), quiet: true });
const chainId = process.env.CHAIN_ID;
if (!existsSync(join(REPO, "contracts", "deployments", `${chainId}.json`))) {
  console.error(`no contracts/deployments/${chainId}.json: run \`npm run deploy -- --network ...\` first`);
  process.exit(1);
}
const standin = process.env.HSP_LOCAL_STANDIN === "1";
const svc = [
  ...(standin ? [["hsp-standin", "services/hsp-standin/src/main.ts", 7301]] : []),
  ["coordinator", "services/coordinator/src/main.ts", 7201],
  ["vault", "services/vault/src/main.ts", 7001],
  ["sellers", "services/sellers/src/main.ts", 7101],
  ["buyer-agent", "services/buyer-agent/src/main.ts", 7002],
];
const children = [];
for (const [name, file] of svc) {
  const p = start(process.execPath, ["--import", "tsx", join(ROOT, file)], { cwd: ROOT, env: { ...process.env, SEALED_ENV: "" }, stdio: ["ignore", "pipe", "pipe"] });
  const tag = `[${name}]`.padEnd(14);
  p.stdout.on("data", (d) => process.stdout.write(d.toString().split("\n").filter(Boolean).map((l) => `${tag} ${l}\n`).join("")));
  p.stderr.on("data", (d) => process.stderr.write(d.toString().split("\n").filter(Boolean).map((l) => `${tag} ${l}\n`).join("")));
  children.push(p);
}
for (const [, , port] of svc) await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok, { what: `service on :${port}`, timeoutMs: 90_000 });
console.log(`Sealed services are up on chain ${chainId}${standin ? " (payments via the HSP local stand-in)" : ""}. Run the flow: npm run e2e`);

const stop = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
