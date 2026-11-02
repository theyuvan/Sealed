import "server-only";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/*
 * Server-side access to the Sealed backend. The browser never talks to the Vault, the buyer agent or the
 * coordinator directly: these helpers run in Next route handlers, which hold the Vault admin token (the owner's
 * token). Never import this from a client component. The UI is the owner's: run it on localhost or behind auth.
 */

const BACKEND = join(resolve(process.cwd(), ".."), "backend");

function parseEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * Same files the backend reads: backend/.env, or backend/.env.local (written by `npm run dev`) when SEALED_ENV=local.
 * With no .env that has the Vault admin token, the local stack's file is used. Process env wins.
 */
function loadBackendEnv(): Record<string, string> {
  const real = parseEnv(join(BACKEND, ".env"));
  const local = parseEnv(join(BACKEND, ".env.local"));
  if (process.env.SEALED_ENV === "local") return local;
  return real.VAULT_ADMIN_TOKEN ? real : local;
}

const fileEnv = loadBackendEnv();
const env = (k: string, d = "") => process.env[k] || fileEnv[k] || d;

const chainId = Number(env("CHAIN_ID", "31337"));

export const config = {
  chainId,
  vaultUrl: env("VAULT_URL", `http://127.0.0.1:${env("VAULT_PORT", "7001")}`),
  buyerUrl: env("BUYER_AGENT_URL", `http://127.0.0.1:${env("BUYER_AGENT_PORT", "7002")}`),
  coordinatorUrl: env("COORDINATOR_URL", `http://127.0.0.1:${env("COORDINATOR_PORT", "7201")}`),
  sellerUrls: env("SELLER_URLS", "http://127.0.0.1:7101,http://127.0.0.1:7102,http://127.0.0.1:7103")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  adminToken: env("VAULT_ADMIN_TOKEN"),
  decimals: Number(env("TOKEN_DECIMALS", "6")),
  probeLimit: Number(env("VAULT_GLOBAL_PROBE_LIMIT", "40")),
  hspMode: env("HSP_LOCAL_STANDIN") === "1" ? "HSP local stand-in" : "HSP",
  // override with EXPLORER_URL if the default host is not the right Blockscout instance
  explorer: (env("EXPLORER_URL") || (chainId === 133 ? "https://testnet-explorer.hskchain.net" : chainId === 177 ? "https://hashkey.blockscout.com" : "")).replace(/\/+$/, ""),
};

export class BackendError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

async function call<T>(base: string, path: string, init: RequestInit & { token?: string; timeoutMs?: number } = {}): Promise<T> {
  const { token, timeoutMs, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...rest,
      cache: "no-store",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs ?? 15_000),
    });
  } catch {
    throw new BackendError(`cannot reach ${base}${path}: is the backend running? (cd backend && npm run dev)`, 503);
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new BackendError(`${path}: non-JSON response (HTTP ${res.status})`, 502);
  }
  if (!res.ok) throw new BackendError((body as { error?: string }).error ?? `${path}: HTTP ${res.status}`, res.status);
  return body as T;
}

export const vault = <T>(path: string, init?: RequestInit & { timeoutMs?: number }) => {
  if (!config.adminToken) throw new BackendError("VAULT_ADMIN_TOKEN is not set (backend/.env or the frontend environment)", 500);
  return call<T>(config.vaultUrl, path, { ...init, token: config.adminToken });
};
export const buyer = <T>(path: string, init?: RequestInit & { timeoutMs?: number }) => call<T>(config.buyerUrl, path, init);
export const coordinator = <T>(path: string, init?: RequestInit) => call<T>(config.coordinatorUrl, path, init);
export const seller = <T>(url: string, path: string) => call<T>(url, path, { timeoutMs: 4_000 });

export function jsonError(e: unknown) {
  const err = e instanceof BackendError ? e : new BackendError((e as Error).message, 500);
  return Response.json({ error: err.message }, { status: err.status });
}
