// MCP server (stdio) for the buyer tools. Run it from an MCP client, for example in Claude Desktop's
// config:  { "command": "npx", "args": ["tsx", "<repo>/backend/services/buyer-agent/src/mcp-main.ts"] }
// Needs the Vault, sellers and coordinator running (npm run dev, or npm start on testnet).
// stdout carries the MCP protocol, so everything human-readable goes to stderr.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadEnv } from "@sealed/core";
import { buyerToolsConfigFromEnv, scrubSecrets } from "./config.ts";
import { buildMcpServer } from "./mcp.ts";
import { BuyerTools } from "./tools.ts";

const config = buyerToolsConfigFromEnv(loadEnv());
scrubSecrets();

await buildMcpServer(new BuyerTools(config)).connect(new StdioServerTransport());
console.error(`sealed-buyer MCP server ready (chain ${config.chainId}, buyer ${config.wallet.address}, ${config.sellerUrls.length} sellers)`);
