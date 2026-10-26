// Runs the full flow against a running stack (npm run dev, or a testnet deployment):
//   seal -> negotiate -> prove -> open -> fund via HSP -> vouchers -> close -> receipt
//   npm run e2e                     scripted buyer (no LLM)
//   npm run e2e -- --llm            the LLM buyer agent (needs LLM_API_KEY or an Anthropic credential)
import { CATEGORIES, accountFromEnv, envInt, loadEnv, requireEnv } from "@sealed/core";
import { createPublicClient, http } from "viem";
import { chainFor } from "@sealed/core";

const env = loadEnv();
const vaultUrl = env.VAULT_URL ?? `http://127.0.0.1:${envInt("VAULT_PORT", 7001)}`;
const buyerUrl = env.BUYER_AGENT_URL ?? `http://127.0.0.1:${envInt("BUYER_AGENT_PORT", 7002)}`;
const sellerUrl = env.E2E_SELLER_URL ?? "http://127.0.0.1:7101";
const admin = requireEnv("VAULT_ADMIN_TOKEN");

const post = async (url: string, body: unknown, token?: string) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${url}: ${JSON.stringify(j)}`);
  return j;
};

// 1. the user seals a mandate (admin only): max 50 USDC, per deal 10, data products, these sellers, 7 days
const pub = createPublicClient({ chain: chainFor(envInt("CHAIN_ID", 31337), requireEnv("HSK_RPC_URL")), transport: http() });
const now = (await pub.getBlock()).timestamp;
const sellers = ["SELLER_1_PRIVATE_KEY", "SELLER_2_PRIVATE_KEY", "ROGUE_PRIVATE_KEY"].filter((k) => env[k]).map((k) => accountFromEnv(k).address);
const sealed = await post(
  `${vaultUrl}/mandate/seal`,
  { maxAmount: "50000000", perDealCap: "10000000", categories: [CATEGORIES["data.nav"], CATEGORIES["data.holders"], CATEGORIES["data.transfers"]], sellers, expiry: String(now + 7n * 86_400n) },
  admin,
);
console.log("sealed mandate, commitment on chain:", sealed.commitment, "tx", sealed.txHash);

// 2-8. the buyer agent does the rest
const run = process.argv.includes("--llm")
  ? await post(`${buyerUrl}/run`, { mode: "llm", task: `Buy 3 calls of the "nav-snapshot" service from the seller at ${sellerUrl}, then close the session and report the receipt.` })
  : await post(`${buyerUrl}/run`, { mode: "scripted", sellerUrl, serviceId: "nav-snapshot", calls: 3 });
console.log(JSON.stringify(run, null, 2));
