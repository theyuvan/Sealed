// Starts honest-1 (7101), honest-2 (7102) and rogue (7103).
import { type Address } from "viem";
import { accountFromEnv, envInt, hspConfigFromEnv, loadDeployment, loadEnv, requireEnv } from "@sealed/core";
import { buildSeller, pricedCatalog } from "./seller.ts";

const env = loadEnv();
const chainId = envInt("CHAIN_ID", 31337);
const deployment = loadDeployment(chainId);
const rpcUrl = requireEnv("HSK_RPC_URL");
const coordinatorUrl = env.COORDINATOR_URL ?? `http://127.0.0.1:${envInt("COORDINATOR_PORT", 7201)}`;
// Assets the data products describe. Defaults to the pinned stablecoin; set DATA_ASSETS to real tokenized-asset contracts.
const dataAssets = (env.DATA_ASSETS ? env.DATA_ASSETS.split(",").map((s) => s.trim()) : [deployment.token]) as Address[];

const sellers = [
  { name: "honest-1", key: "SELLER_1_PRIVATE_KEY", port: 7101, list: 12_000_000n, reserve: 6_000_000n },
  { name: "honest-2", key: "SELLER_2_PRIVATE_KEY", port: 7102, list: 14_000_000n, reserve: 7_000_000n },
  { name: "rogue", key: "ROGUE_PRIVATE_KEY", port: 7103, list: 30_000_000n, reserve: 1_000_000n },
];

for (const s of sellers) {
  const rogue =
    s.name === "rogue"
      ? {
          injection: true,
          urgentFee: 5_000_000n,
          probe: true,
          cartSwap: env.ROGUE_HSP_APP_KEY
            ? { hsp: { ...hspConfigFromEnv({ ...env, HSP_APP_KEY: env.ROGUE_HSP_APP_KEY, HSP_APP_SECRET: env.ROGUE_HSP_APP_SECRET, HSP_MERCHANT_PRIVATE_KEY: env.ROGUE_HSP_MERCHANT_PRIVATE_KEY }, chainId) } }
            : undefined,
        }
      : undefined;
  const app = buildSeller({
    name: s.name,
    account: accountFromEnv(s.key),
    chainId,
    rpcUrl,
    deployment,
    coordinatorUrl,
    publicUrl: `http://127.0.0.1:${s.port}`,
    items: pricedCatalog({ listPrice: s.list, reservePrice: s.reserve }),
    dataAssets,
    rogue,
  });
  await app.listen({ host: env.SELLERS_HOST ?? "127.0.0.1", port: s.port });
  console.log(`${s.name} listening on :${s.port}`);
}
