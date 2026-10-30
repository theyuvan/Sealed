import { HSP_DEFAULT_PATHS, accountFromEnv, envInt, loadDeployment, loadEnv, requireEnv } from "@sealed/core";
import type { BuyerToolsConfig } from "./tools.ts";
import { VaultAgentClient } from "./vault-client.ts";

/**
 * Buyer tool configuration from backend/.env. Reads the buyer wallet key and the Vault agent token
 * (the only two secrets the buyer needs); call scrubSecrets() afterwards.
 */
export function buyerToolsConfigFromEnv(env: NodeJS.ProcessEnv = loadEnv()): BuyerToolsConfig {
  const chainId = envInt("CHAIN_ID", 31337);
  const wallet = accountFromEnv("BUYER_WALLET_PRIVATE_KEY");
  const agentToken = requireEnv("VAULT_AGENT_TOKEN");
  const standin = env.HSP_LOCAL_STANDIN === "1";
  const mcp = env.HSP_MODE === "mcp" || (env.HSP_MODE !== "api" && !standin);
  const hspBase = standin ? (env.HSP_STANDIN_URL ?? "http://127.0.0.1:7301") : mcp ? "" : requireEnv("HSP_PAYER_BASE_URL");
  return {
    chainId,
    rpcUrl: requireEnv("HSK_RPC_URL"),
    deployment: loadDeployment(chainId),
    wallet,
    vault: new VaultAgentClient(env.VAULT_URL ?? `http://127.0.0.1:${envInt("VAULT_PORT", 7001)}`, agentToken),
    hsp: {
      ...(mcp ? { mode: "mcp" as const, mcpUrl: env.HSP_MCP_URL ?? (standin ? hspBase : "https://mcp-qa.hashkeymerchant.com/"), merchantName: env.HSP_MERCHANT_NAME ?? "Sealed" } : {}),
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
  };
}

/**
 * The agent process keeps only what it needs. Everything else (vault admin token, other services'
 * keys, merchant secrets, LLM keys) is removed from its environment before any tool runs.
 */
export function scrubSecrets(env: NodeJS.ProcessEnv = process.env): void {
  for (const k of Object.keys(env)) {
    if (/PRIVATE_KEY|SECRET|ADMIN_TOKEN|APP_KEY|AGENT_TOKEN|API_KEY/.test(k)) delete env[k];
  }
}
