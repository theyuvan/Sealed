// `node scripts/forge.mjs <args>` runs forge inside contracts/ using the repo-local toolchain.
import { join } from "node:path";
import { REPO, ROOT, run, tool } from "./lib.mjs";

try {
  run(tool("forge"), process.argv.slice(2), { cwd: join(REPO, "contracts") });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
