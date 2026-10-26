// Downloads Foundry (forge, anvil, cast) and Circom into .tools/bin for this platform.
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, run } from "./lib.mjs";

const FOUNDRY = "v1.8.6";
const CIRCOM = "v2.2.3";
const bin = join(ROOT, ".tools", "bin");
mkdirSync(bin, { recursive: true });
const win = process.platform === "win32";
const exe = win ? ".exe" : "";

const plat = { win32: "win32", darwin: "darwin", linux: "linux" }[process.platform];
const arch = process.arch === "arm64" ? "arm64" : "amd64";
if (!plat) throw new Error(`unsupported platform ${process.platform}`);

async function download(url, dest) {
  console.log(`downloading ${url}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

if (!existsSync(join(bin, `forge${exe}`))) {
  const ext = win ? "zip" : "tar.gz";
  const archive = join(bin, `foundry.${ext}`);
  await download(`https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY}/foundry_${FOUNDRY}_${plat}_${arch}.${ext}`, archive);
  if (win) run("tar", ["-xf", archive, "-C", bin]);
  else run("tar", ["-xzf", archive, "-C", bin]);
  rmSync(archive);
}

if (!existsSync(join(bin, `circom${exe}`))) {
  const name = win ? "circom-windows-amd64.exe" : process.platform === "darwin" ? "circom-macos-amd64" : "circom-linux-amd64";
  await download(`https://github.com/iden3/circom/releases/download/${CIRCOM}/${name}`, join(bin, `circom${exe}`));
  if (!win) chmodSync(join(bin, "circom"), 0o755);
}

run(join(bin, `forge${exe}`), ["--version"]);
run(join(bin, `circom${exe}`), ["--version"]);
