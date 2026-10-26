import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const backend = fileURLToPath(new URL(".", import.meta.url));
const circuits = resolve(backend, "..", "circuits");

const shared = {
  testTimeout: 120_000,
  hookTimeout: 300_000,
  pool: "forks" as const,
  fileParallelism: false,
};

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: "backend", root: backend, include: ["packages/**/*.test.ts", "services/**/*.test.ts", "tests/**/*.test.ts"], ...shared },
      },
      {
        // circuit tests live in ../circuits/test, which has no node_modules: map the workspace packages to backend sources
        resolve: {
          alias: {
            "@sealed/core": resolve(backend, "packages/core/src/index.ts"),
            "@sealed/prover": resolve(backend, "packages/prover/src/index.ts"),
            vitest: resolve(backend, "node_modules/vitest/dist/index.js"),
          },
        },
        server: { fs: { allow: [backend, circuits] } },
        test: { name: "circuits", root: circuits, include: ["test/**/*.test.ts"], ...shared },
      },
    ],
  },
});
