import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, type Chain, defineChain, http } from "viem";

export const hskMainnet = defineChain({
  id: 177,
  name: "HashKey Chain",
  nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
  rpcUrls: { default: { http: ["https://mainnet.hsk.xyz"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://hashkey.blockscout.com" } },
});

export const hskTestnet = defineChain({
  id: 133,
  name: "HashKey Chain Testnet",
  nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet.hsk.xyz"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://testnet-explorer.hskchain.net" } },
  testnet: true,
});

export const localAnvil = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});

export function chainFor(chainId: number, rpcUrl?: string): Chain {
  const base = chainId === 177 ? hskMainnet : chainId === 133 ? hskTestnet : chainId === 31337 ? localAnvil : undefined;
  if (!base) throw new Error(`unsupported chain id ${chainId}`);
  return rpcUrl ? { ...base, rpcUrls: { default: { http: [rpcUrl] } } } : base;
}

/**
 * JSON-RPC transport for every service. Public HSK RPCs sit behind rate limiting (Cloudflare 1015 /
 * HTTP 429), so calls are batched into fewer HTTP requests and rate-limited calls are retried with
 * exponential backoff (1s, 2s, 4s, ...).
 */
export function rpcTransport(url?: string) {
  return http(url, { batch: { wait: 16 }, retryCount: 6, retryDelay: 1_000, timeout: 30_000 });
}

export function explorerTx(chainId: number, tx: string): string | null {
  const url = chainFor(chainId).blockExplorers?.default.url;
  return url ? `${url}/tx/${tx}` : null;
}

export interface Deployment {
  chainId: number;
  registry: Address;
  escrow: Address;
  verifier: Address;
  token: Address;
  coordinator: Address;
  deployBlock: number;
}

/** backend/ (node workspace, .env, data/) */
export const BACKEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
/** repository root (contracts/, circuits/) */
export const REPO_ROOT = resolve(BACKEND_ROOT, "..");

export function deploymentPath(chainId: number): string {
  return join(REPO_ROOT, "contracts", "deployments", `${chainId}.json`);
}

/** Addresses: env vars win over contracts/deployments/<chainId>.json. */
export function loadDeployment(chainId: number, env: NodeJS.ProcessEnv = process.env): Deployment {
  const file = deploymentPath(chainId);
  const fromFile: Partial<Deployment> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const pick = (envKey: string, k: keyof Deployment) => (env[envKey] as Address | undefined) || (fromFile[k] as Address | undefined);
  const d = {
    chainId,
    registry: pick("REGISTRY_ADDRESS", "registry"),
    escrow: pick("ESCROW_ADDRESS", "escrow"),
    verifier: pick("VERIFIER_ADDRESS", "verifier"),
    token: pick("PINNED_TOKEN", "token"),
    coordinator: pick("COORDINATOR_ADDRESS", "coordinator"),
    // empty env values (e.g. `DEPLOY_BLOCK=` left blank in .env) count as unset
    deployBlock: Number(env.DEPLOY_BLOCK || fromFile.deployBlock || 0),
  };
  for (const k of ["registry", "escrow", "token"] as const) {
    if (!d[k]) throw new Error(`deployment for chain ${chainId} is missing ${k} (set env or ${file})`);
  }
  return d as Deployment;
}
