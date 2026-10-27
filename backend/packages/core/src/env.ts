import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import { type Hex, nonceManager } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { BACKEND_ROOT } from "./chain.ts";

let loaded = false;

/**
 * Loads backend/.env, or backend/.env.local (the local anvil stack written by scripts/dev) when
 * SEALED_ENV=local or the command line has --local. Values already in the environment win.
 * Never logs values.
 */
export function loadEnv(): NodeJS.ProcessEnv {
  if (!loaded) {
    const local = process.env.SEALED_ENV === "local" || process.argv.includes("--local");
    const p = join(BACKEND_ROOT, local ? ".env.local" : ".env");
    if (existsSync(p)) config({ path: p, override: false, quiet: true });
    loaded = true;
  }
  return process.env;
}

export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

/**
 * Account from a private-key env var. The key itself never leaves this function.
 * Nonces are tracked locally: load-balanced RPCs (HSK testnet) can return a stale pending nonce,
 * which makes back-to-back transactions collide ("replacement transaction underpriced").
 */
export function accountFromEnv(name: string, env: NodeJS.ProcessEnv = process.env): PrivateKeyAccount {
  const v = requireEnv(name, env);
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`env ${name} is not a 32-byte 0x-hex private key`);
  return privateKeyToAccount(v as Hex, { nonceManager });
}

export function envInt(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const v = env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name} is not a number`);
  return n;
}
