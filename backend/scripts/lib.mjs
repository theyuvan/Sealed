// Shared helpers for the node scripts (cross-platform: Windows, macOS, Linux).
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

/** backend/ (node workspace, .env, .tools, data/) */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** repository root (contracts/, circuits/) */
export const REPO = resolve(ROOT, "..");
const EXE = process.platform === "win32" ? ".exe" : "";

/** Path of a toolchain binary: backend/.tools/bin first, then PATH. */
export function tool(name) {
  const local = join(ROOT, ".tools", "bin", `${name}${EXE}`);
  return existsSync(local) ? local : name;
}

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited with ${r.status}`);
  return r;
}

export function start(cmd, args, opts = {}) {
  return spawn(cmd, args, { stdio: "inherit", ...opts });
}

export async function waitFor(fn, { timeoutMs = 30_000, intervalMs = 250, what = "condition" } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return;
    } catch {}
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function rpcUp(url) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
  return res.ok;
}

export async function ask(question) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(question);
  rl.close();
  return a.trim();
}
