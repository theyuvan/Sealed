import { accountFromEnv, envInt, HSP_DEFAULT_PATHS, loadDeployment, loadEnv, requireEnv } from "@sealed/core";
import { VaultAgentClient } from "./vault-client.ts";
import { buildBuyerServer } from "./server.ts";

const env = loadEnv();
const chainId = envInt("CHAIN_ID", 31337);
const wallet = accountFromEnv("BUYER_WALLET_PRIVATE_KEY");
const agentToken = requireEnv("VAULT_AGENT_TOKEN");
const llmApiKey = env.LLM_API_KEY || undefined;

// The agent process keeps only what it needs. Everything else (vault admin token, other services'
// keys, merchant secrets) is removed from its environment before any tool runs.
for (const k of Object.keys(process.env)) {
  if (/PRIVATE_KEY|SECRET|ADMIN_TOKEN|APP_KEY|AGENT_TOKEN|LLM_API_KEY/.test(k)) delete process.env[k];
}

const standin = env.HSP_LOCAL_STANDIN === "1";
const hspBase = standin ? (env.HSP_STANDIN_URL ?? "http://127.0.0.1:7301") : requireEnv("HSP_PAYER_BASE_URL");
const app = buildBuyerServer(
  {
    chainId,
    rpcUrl: requireEnv("HSK_RPC_URL"),
    deployment: loadDeployment(chainId),
    wallet,
    vault: new VaultAgentClient(env.VAULT_URL ?? `http://127.0.0.1:${envInt("VAULT_PORT", 7001)}`, agentToken),
    hsp: {
      baseUrl: hspBase,
      payerBaseUrl: hspBase,
      paths: {
        createOrder: env.HSP_PATH_CREATE_ORDER ?? HSP_DEFAULT_PATHS.createOrder,
        payments: env.HSP_PATH_PAYMENTS ?? HSP_DEFAULT_PATHS.payments,
        cartByFlow: env.HSP_PATH_CART_BY_FLOW ?? HSP_DEFAULT_PATHS.cartByFlow,
        payMandate: env.HSP_PATH_PAY_MANDATE ?? HSP_DEFAULT_PATHS.payMandate,
      },
      x402Method: env.HSP_X402_METHOD ?? "https://www.x402.org/",
      jwtAudience: env.HSP_JWT_AUDIENCE ?? "HashkeyMerchant",
    },
    coordinatorUrl: env.COORDINATOR_URL ?? `http://127.0.0.1:${envInt("COORDINATOR_PORT", 7201)}`,
    sellerUrls: (env.SELLER_URLS ?? "http://127.0.0.1:7101,http://127.0.0.1:7102,http://127.0.0.1:7103").split(",").map((s) => s.trim()),
    decimals: envInt("TOKEN_DECIMALS", 6),
  },
  { llmApiKey, logger: true },
);
await app.listen({ host: "127.0.0.1", port: envInt("BUYER_AGENT_PORT", 7002) });
