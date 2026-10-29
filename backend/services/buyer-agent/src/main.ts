import { envInt, loadEnv } from "@sealed/core";
import { llmFromEnv } from "./agent.ts";
import { buyerToolsConfigFromEnv, scrubSecrets } from "./config.ts";
import { buildBuyerServer } from "./server.ts";

const env = loadEnv();
const toolsConfig = buyerToolsConfigFromEnv(env);
const llm = llmFromEnv(env);
scrubSecrets();

const app = buildBuyerServer(toolsConfig, { llm, logger: true });
await app.listen({ host: "127.0.0.1", port: envInt("BUYER_AGENT_PORT", 7002) });
