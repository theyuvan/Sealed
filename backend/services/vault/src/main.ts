import { join } from "node:path";
import { type Address, type Hex } from "viem";
import { BACKEND_ROOT, accountFromEnv, envInt, loadDeployment, loadEnv, requireEnv } from "@sealed/core";
import { Vault } from "./vault.ts";
import { buildVaultServer } from "./server.ts";

const env = loadEnv();
const chainId = envInt("CHAIN_ID", 31337);
const vault = new Vault({
  chainId,
  rpcUrl: requireEnv("HSK_RPC_URL"),
  deployment: loadDeployment(chainId),
  account: accountFromEnv("VAULT_PRIVATE_KEY"),
  // The Vault only needs the buyer's address, never its key.
  buyer: (env.BUYER_WALLET_ADDRESS as Address | undefined) ?? accountFromEnv("BUYER_WALLET_PRIVATE_KEY").address,
  auditorPublicKey: requireEnv("AUDITOR_PUBLIC_KEY") as Hex,
  dbPath: env.VAULT_DB_PATH ?? join(BACKEND_ROOT, "data", `vault-${chainId}.sqlite`),
  globalProbeLimit: envInt("VAULT_GLOBAL_PROBE_LIMIT", 40),
  perSellerNegotiations: envInt("VAULT_PER_SELLER_NEGOTIATIONS", 3),
  sellerCooldownMs: envInt("VAULT_SELLER_COOLDOWN_MS", 30_000),
  responseDelayMs: envInt("VAULT_RESPONSE_DELAY_MS", 1500),
  sessionSeconds: envInt("VAULT_SESSION_SECONDS", 3600),
  autoRotate: env.VAULT_AUTO_ROTATE !== "0",
});

const app = buildVaultServer(vault, {
  adminToken: requireEnv("VAULT_ADMIN_TOKEN"),
  agentToken: requireEnv("VAULT_AGENT_TOKEN"),
  responseDelayMs: vault.cfg.responseDelayMs,
  logger: true,
});
const port = envInt("VAULT_PORT", 7001);
// The Vault runs on the user's side and is never exposed to sellers: bind to loopback only.
await app.listen({ host: "127.0.0.1", port });
