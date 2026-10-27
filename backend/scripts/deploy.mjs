// Deploy to HSK testnet (133) or mainnet (177).
//   node scripts/deploy.mjs --network testnet
//   node scripts/deploy.mjs --network mainnet     (asks for a typed confirmation; spends real HSK)
// Reads .env: DEPLOYER_PRIVATE_KEY, COORDINATOR_PRIVATE_KEY (or COORDINATOR_ADDRESS), PINNED_TOKEN,
// HSK_RPC_URL / HSK_TESTNET_RPC_URL. Add --legacy if EIP-1559 fee estimation fails on HSK.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import { privateKeyToAccount } from "viem/accounts";
import { REPO, ROOT, ask, run, tool } from "./lib.mjs";

config({ path: join(ROOT, ".env"), quiet: true });
const i = process.argv.indexOf("--network");
const network = i >= 0 ? process.argv[i + 1] : undefined;
const nets = {
  testnet: { chainId: 133, rpc: process.env.HSK_TESTNET_RPC_URL ?? "https://testnet.hsk.xyz" },
  mainnet: { chainId: 177, rpc: process.env.HSK_RPC_URL ?? "https://mainnet.hsk.xyz" },
};
const net = nets[network];
if (!net) {
  console.error("usage: node scripts/deploy.mjs --network testnet|mainnet [--legacy]");
  process.exit(1);
}
for (const k of ["DEPLOYER_PRIVATE_KEY"]) if (!process.env[k]) throw new Error(`missing ${k} in .env`);
const coordinator = process.env.COORDINATOR_ADDRESS ?? (process.env.COORDINATOR_PRIVATE_KEY ? privateKeyToAccount(process.env.COORDINATOR_PRIVATE_KEY).address : undefined);
if (!coordinator) throw new Error("set COORDINATOR_PRIVATE_KEY or COORDINATOR_ADDRESS in .env");
if (network === "mainnet" && !process.env.PINNED_TOKEN) throw new Error("PINNED_TOKEN is required on mainnet (the verified HSP-supported EIP-3009 stablecoin)");
if (network === "testnet" && !process.env.PINNED_TOKEN) console.warn("PINNED_TOKEN not set: a DEV token will be deployed (real HSP will not settle it).");

const out = join(REPO, "contracts", "deployments", `${net.chainId}.json`);
console.log(`network ${network} (${net.chainId}), rpc ${net.rpc}`);
console.log(`deployer ${privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY).address}, coordinator ${coordinator}, token ${process.env.PINNED_TOKEN ?? "(dev token)"}`);
if (existsSync(out)) console.log(`note: ${out} exists and will be overwritten:\n${readFileSync(out, "utf8")}`);

const env = { ...process.env, COORDINATOR_ADDRESS: coordinator, CONFIRM_MAINNET: "" };
// forge cannot parse empty optional values (e.g. `PINNED_TOKEN=` left blank in .env)
for (const k of ["PINNED_TOKEN", "ESCROW_OWNER"]) if (!env[k]) delete env[k];
if (network === "mainnet") {
  const a = await ask('This deploys to HSK MAINNET and spends real HSK for gas. Type "deploy to mainnet" to continue: ');
  if (a !== "deploy to mainnet") {
    console.log("aborted");
    process.exit(1);
  }
  env.CONFIRM_MAINNET = "yes";
}
const args = ["script", "script/Deploy.s.sol", "--rpc-url", net.rpc, "--broadcast", "--slow"];
if (process.argv.includes("--legacy")) args.push("--legacy");
run(tool("forge"), args, { cwd: join(REPO, "contracts"), env });
console.log(`deployment written to ${out}`);
