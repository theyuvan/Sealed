import { join } from "node:path";
import { BACKEND_ROOT, accountFromEnv, envInt, hspConfigFromEnv, loadDeployment, loadEnv, requireEnv } from "@sealed/core";
import { Coordinator } from "./coordinator.ts";
import { buildCoordinatorServer } from "./server.ts";

const env = loadEnv();
const chainId = envInt("CHAIN_ID", 31337);
const hsp = hspConfigFromEnv(env, chainId);
const coordinator = new Coordinator({
  chainId,
  rpcUrl: requireEnv("HSK_RPC_URL"),
  deployment: loadDeployment(chainId),
  account: accountFromEnv("COORDINATOR_PRIVATE_KEY"),
  hsp,
  decimals: envInt("TOKEN_DECIMALS", 6),
  dbPath: env.COORDINATOR_DB_PATH ?? join(BACKEND_ROOT, "data", `coordinator-${chainId}.sqlite`),
  logsChunk: BigInt(envInt("LOGS_CHUNK", 5000)),
  log: (msg, data) => app.log.info(data ?? {}, msg),
});
const app = buildCoordinatorServer(coordinator, { logger: true });
if (hsp.localStandIn) app.log.warn("using the HSP local stand-in (development only)");

// Polling backs up webhooks, so a slow or missed HSP callback never loses a settlement.
const pollMs = envInt("COORDINATOR_POLL_MS", 3000);
const loop = async () => {
  await coordinator.pollOnce().catch((e) => app.log.error(e));
  setTimeout(loop, pollMs);
};
setTimeout(loop, pollMs);

const port = envInt("COORDINATOR_PORT", 7201);
await app.listen({ host: env.COORDINATOR_HOST ?? "127.0.0.1", port });
