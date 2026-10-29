import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { SYSTEM_PROMPT, TOOL_DEFS } from "./llm.ts";
import type { BuyerTools } from "./tools.ts";

/*
 * MCP server for the buyer tools. Any MCP client (Claude Desktop, an IDE, another agent) can act
 * as the buyer: it gets exactly the seven tools the built-in LLM agent has, backed by the same
 * BuyerTools code. It never gets the mandate: the budget, caps and allow-lists stay in the Vault,
 * and money moves only through a Vault spend proof and signed vouchers.
 */

type Schema = { type: "object"; properties?: Record<string, { type?: string }>; required?: string[]; additionalProperties?: boolean };

/** What each tool does to the world, so clients can ask before the ones that spend. */
const HINTS: Record<string, { title: string; readOnly: boolean; destructive: boolean; idempotent: boolean }> = {
  discover_sellers: { title: "Discover sellers", readOnly: true, destructive: false, idempotent: true },
  request_quote: { title: "Request a signed quote", readOnly: false, destructive: false, idempotent: false },
  propose: { title: "Send a quote to the Vault", readOnly: false, destructive: false, idempotent: false },
  open_session: { title: "Open and fund an escrow session", readOnly: false, destructive: true, idempotent: false },
  call_service: { title: "Make one paid call", readOnly: false, destructive: true, idempotent: false },
  check_delivery: { title: "Show the last delivery check", readOnly: true, destructive: false, idempotent: true },
  close_session: { title: "Close and settle a session", readOnly: false, destructive: true, idempotent: false },
};

export const MCP_TOOLS: Tool[] = TOOL_DEFS.map((d) => {
  const h = HINTS[d.name]!;
  return {
    name: d.name,
    description: d.description ?? "",
    inputSchema: d.input_schema as Tool["inputSchema"],
    annotations: { title: h.title, readOnlyHint: h.readOnly, destructiveHint: h.destructive, idempotentHint: h.idempotent, openWorldHint: true },
  };
});

/** The model on the other end is untrusted: accept only the declared string arguments, nothing else. */
export function validateArgs(schema: Schema, args: unknown): string | null {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  const a = args as Record<string, unknown>;
  const props = schema.properties ?? {};
  for (const k of Object.keys(a)) if (!(k in props)) return `unexpected argument "${k}"`;
  for (const k of schema.required ?? []) if (a[k] === undefined) return `missing required argument "${k}"`;
  for (const [k, v] of Object.entries(a)) {
    if (props[k]?.type === "string" && (typeof v !== "string" || v.length === 0 || v.length > 2000)) return `argument "${k}" must be a non-empty string`;
  }
  return null;
}

export function buildMcpServer(tools: BuyerTools): Server {
  const server = new Server({ name: "sealed-buyer", version: "0.1.0" }, { capabilities: { tools: {} }, instructions: SYSTEM_PROMPT });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: MCP_TOOLS }));

  // One tool at a time: negotiation and payment steps must not interleave.
  let queue: Promise<unknown> = Promise.resolve();
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = MCP_TOOLS.find((t) => t.name === req.params.name);
    if (!tool) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: `unknown tool ${req.params.name}` }) }] };
    const bad = validateArgs(tool.inputSchema as Schema, req.params.arguments);
    if (bad) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: bad }) }] };

    const run = queue.then(() => tools.run(tool.name, (req.params.arguments ?? {}) as Record<string, unknown>));
    queue = run.catch(() => undefined);
    const output = await run;
    return { isError: output.error !== undefined, content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
  });

  return server;
}
