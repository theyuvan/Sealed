// HSP Agentic Payment readiness check (the hackathon QA route): run it before the first real purchase.
//   npm run hsp:check         reads backend/.env
// It creates nothing and spends nothing: a health check, the tool list, and get_chain_config.
// (The older signed Merchant API check is `npm run hsp:check:api`.)
import { createPublicClient } from "viem";
import { HSP_MCP_TOOLS, HspMcpClient, chainFor, chainTokenProblems, envInt, findChainToken, hspConfigFromEnv, loadDeployment, loadEnv, readTokenDomain, rpcTransport } from "@sealed/core";

const env = loadEnv();
const chainId = envInt("CHAIN_ID", 31337);
let failed = 0;
const mark = (ok: boolean | null, name: string, detail = "") => {
  if (ok === false) failed++;
  console.log(`${ok === true ? "ok  " : ok === false ? "FAIL" : "todo"}  ${name}${detail ? `\n        ${detail.replaceAll("\n", "\n        ")}` : ""}`);
};

console.log(`HSP Agentic Payment readiness, chain ${chainId}\n`);
const cfg = hspConfigFromEnv({ ...env, HSP_MODE: "mcp" }, chainId);
if (cfg.localStandIn) mark(false, "HSP_LOCAL_STANDIN is on", "This check is for the real gateway. Set HSP_LOCAL_STANDIN=0 in backend/.env.");
mark(chainId === 133, "CHAIN_ID is the HashKey testnet (133)", chainId === 133 ? "" : `CHAIN_ID is ${chainId}; the QA environment settles on testnet`);
mark(Boolean(env.HSP_MERCHANT_NAME), "HSP_MERCHANT_NAME is set", `"${cfg.merchantName}" is the team's reporting name: it must be spelled the same at create_order and query_payment, and it decides post-event aggregation`);

const base = new URL(cfg.mcpUrl!);
const health = await fetch(new URL("/health", base), { signal: AbortSignal.timeout(10_000) }).then(
  async (r) => ({ ok: r.ok, text: (await r.text()).slice(0, 80) }),
  (e: Error) => ({ ok: false, text: e.message }),
);
mark(health.ok, `MCP endpoint ${cfg.mcpUrl} is alive`, health.ok ? health.text : `${health.text}\nIf this is a timeout or 403, the machine's public egress IP is probably not on HSP's QA allowlist yet: send it to HSP and wait for confirmation (guide step 1).`);

if (health.ok) {
  const client = new HspMcpClient({ url: cfg.mcpUrl, merchantName: cfg.merchantName });
  try {
    const schemas = await client.toolSchemas();
    mark(HSP_MCP_TOOLS.every((t) => t in schemas), "all eight tools are present", HSP_MCP_TOOLS.map((t) => `${t}(${Object.keys(schemas[t]?.properties ?? {}).join(", ")})`).join("\n"));
    const config = await client.getChainConfig();
    console.log(`\nget_chain_config:\n${JSON.stringify(config, null, 2).split("\n").map((l) => `        ${l}`).join("\n")}\n`);
    let deployment: ReturnType<typeof loadDeployment> | null = null;
    try {
      deployment = loadDeployment(chainId);
    } catch (e) {
      mark(null, "deployment", (e as Error).message);
    }
    if (deployment) {
      const t = findChainToken(config, chainId, deployment.token);
      const problems = chainTokenProblems(t, { decimals: envInt("TOKEN_DECIMALS", 6) });
      mark(problems.length === 0, "the deployed token is one HSP settles, with eip3009", problems.length ? `${problems.join("\n")}\nredeploy with PINNED_TOKEN=<address from get_chain_config> TOKEN_DECIMALS=<decimals>` : `${t!.symbol} ${t!.address} on ${t!.network}`);
      if (env.HSK_RPC_URL) {
        const pub = createPublicClient({ chain: chainFor(chainId, env.HSK_RPC_URL), transport: rpcTransport(env.HSK_RPC_URL) });
        const d = await readTokenDomain(pub, deployment.token).catch(() => null);
        mark(d !== null, "token has an EIP-712 domain on chain", d ? `"${d.name}" v${d.version}` : "");
      }
    }
  } catch (e) {
    mark(false, "talking to the MCP server", (e as Error).message);
  } finally {
    await client.close();
  }
}

console.log(`\n${failed === 0 ? "No failures." : `${failed} failure(s).`} Not covered here: the payer wallet needs the exact token from get_chain_config (testnet funds come from HashKey), and an end-to-end order is the only full test.`);
process.exit(failed === 0 ? 0 : 1);
