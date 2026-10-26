import { join } from "node:path";
import { createPublicKey } from "node:crypto";
import { BACKEND_ROOT, accountFromEnv, envInt, hspConfigFromEnv, loadDeployment, loadEnv, merchantKey, requireEnv } from "@sealed/core";
import { STANDIN_LABEL, buildStandIn, type StandInMerchant } from "./standin.ts";

const env = loadEnv();
if (env.HSP_LOCAL_STANDIN !== "1") {
  console.error(`${STANDIN_LABEL} is disabled (set HSP_LOCAL_STANDIN=1 for development).`);
  process.exit(1);
}
const chainId = envInt("CHAIN_ID", 31337);
const hsp = hspConfigFromEnv(env, chainId); // throws on mainnet
const merchants: StandInMerchant[] = [
  {
    name: hsp.merchantName,
    appKey: hsp.appKey,
    appSecret: hsp.appSecret,
    webhookSecret: hsp.webhookSecret,
    publicKey: createPublicKey(merchantKey(hsp.merchantPrivateKey)),
    webhookUrl: env.HSP_WEBHOOK_URL ?? `http://127.0.0.1:${envInt("COORDINATOR_PORT", 7201)}/hsp/webhook`,
  },
];
// The rogue seller registers as its own HSP merchant (any merchant can), for the cart-swap attack demo.
if (env.ROGUE_HSP_APP_KEY && env.ROGUE_HSP_APP_SECRET && env.ROGUE_HSP_MERCHANT_PRIVATE_KEY) {
  merchants.push({
    name: "rogue",
    appKey: env.ROGUE_HSP_APP_KEY,
    appSecret: env.ROGUE_HSP_APP_SECRET,
    webhookSecret: env.ROGUE_HSP_APP_SECRET,
    publicKey: createPublicKey(merchantKey(env.ROGUE_HSP_MERCHANT_PRIVATE_KEY)),
  });
}
const port = envInt("HSP_STANDIN_PORT", 7301);
const app = buildStandIn({
  chainId,
  rpcUrl: requireEnv("HSK_RPC_URL"),
  token: loadDeployment(chainId).token,
  decimals: envInt("TOKEN_DECIMALS", 6),
  hsp,
  relayer: accountFromEnv("HSP_STANDIN_RELAYER_PRIVATE_KEY"),
  merchants,
  publicUrl: `http://127.0.0.1:${port}`,
  dbPath: join(BACKEND_ROOT, "data", `hsp-standin-${chainId}.sqlite`),
});
await app.listen({ host: "127.0.0.1", port });
console.log(`${STANDIN_LABEL} listening on :${port} (development only, not HashKey)`);
