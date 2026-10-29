import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { keccak256, stringToHex } from "viem";
import { canonicalJson } from "@sealed/core";
import { shutdownProver } from "@sealed/prover";
import { AGENT_TOKEN, startStack, type Stack } from "../../../tests/stack.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MCP_TOOLS, TOOL_DEFS, buildMcpServer, checkDelivery, llmFromEnv, runAgent, runLlmAgent, runScripted, validateArgs, type BuyerTools } from "../src/index.ts";

/** An MCP client wired to the buyer's MCP server in memory, as Claude Desktop would be over stdio. */
async function mcpClient(tools: BuyerTools) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(tools).connect(serverSide);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { type: string; text: string }[])[0]!.text;
    return { isError: Boolean(r.isError), text, json: JSON.parse(text) as Record<string, unknown> };
  };
  return { client, call };
}

describe("MCP argument validation", () => {
  const schema = { type: "object" as const, properties: { quote_id: { type: "string" } }, required: ["quote_id"], additionalProperties: false };
  it("accepts only the declared non-empty string arguments", () => {
    expect(validateArgs(schema, { quote_id: "q1" })).toBeNull();
    expect(validateArgs(schema, {})).toMatch(/missing required/);
    expect(validateArgs(schema, { quote_id: "q1", budget: "x" })).toMatch(/unexpected argument "budget"/);
    expect(validateArgs(schema, { quote_id: 7 })).toMatch(/non-empty string/);
    expect(validateArgs(schema, { quote_id: "" })).toMatch(/non-empty string/);
    expect(validateArgs(schema, { quote_id: "x".repeat(2001) })).toMatch(/non-empty string/);
    expect(validateArgs(schema, [])).toMatch(/must be an object/);
    expect(validateArgs({ type: "object", properties: {} }, undefined)).toBeNull();
  });
  it("reuses the LLM agent's tool definitions, one for one", () => {
    expect(MCP_TOOLS.map((t) => t.name)).toEqual(TOOL_DEFS.map((t) => t.name));
    expect(MCP_TOOLS.map((t) => t.inputSchema)).toEqual(TOOL_DEFS.map((t) => t.input_schema));
  });
});

describe("checkDelivery (deterministic)", () => {
  const sessionId = keccak256(stringToHex("s"));
  const body = canonicalJson({ service: "nav-snapshot", sessionId, call: 1, chainId: 31337, block: "5", data: [{ asset: "0x" + "11".repeat(20), symbol: "X", decimals: 6, totalSupply: "1" }] });
  const base = { serviceId: "nav-snapshot", body, committedHash: keccak256(stringToHex(body)), latencyMs: 10, timeoutMs: 1000, sessionId, expectedCall: 1, chainId: 31337 };
  it("passes a well-formed delivery", () => expect(checkDelivery(base)).toEqual({ ok: true, reasons: [] }));
  it("fails on hash mismatch, schema mismatch, wrong session, wrong call, slow delivery", () => {
    expect(checkDelivery({ ...base, committedHash: keccak256(stringToHex("x")) }).ok).toBe(false);
    expect(checkDelivery({ ...base, serviceId: "recent-transfers" }).ok).toBe(false);
    expect(checkDelivery({ ...base, sessionId: keccak256(stringToHex("t")) }).ok).toBe(false);
    expect(checkDelivery({ ...base, expectedCall: 2 }).ok).toBe(false);
    expect(checkDelivery({ ...base, latencyMs: 5000 }).ok).toBe(false);
    const garbage = "not json";
    expect(checkDelivery({ ...base, body: garbage, committedHash: keccak256(stringToHex(garbage)) }).reasons).toContain("body is not JSON");
  });
});

describe("buyer agent against the full stack", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(async () => {
    await stack?.stop();
    await shutdownProver();
  });

  it("the agent token cannot read or change the mandate", async () => {
    for (const [method, path] of [["GET", "/mandate/status"], ["POST", "/mandate/seal"], ["POST", "/mandate/revoke"], ["GET", "/traces"]] as const) {
      const r = await fetch(`${stack.vaultUrl}${path}`, { method, headers: { authorization: `Bearer ${AGENT_TOKEN}`, "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      expect(r.status).toBe(403);
    }
  });

  it("scripted driver: negotiates, opens, funds via HSP, pays per call, closes with a receipt", async () => {
    const tools = stack.buyerTools();
    const r = await runScripted(tools, { sellerUrl: stack.urls.honest1, serviceId: "nav-snapshot", calls: 2 });
    expect(r.outcome).toBe("closed");
    const proposes = r.steps.filter((s) => s.tool === "propose");
    expect(proposes.length).toBeGreaterThan(1); // honest-1 lists above the hidden target, so there are counters
    const receipt = r.receipt as { paid: string; refunded: string };
    expect(BigInt(receipt.paid) + BigInt(receipt.refunded) > 0n).toBe(true);
  });

  it("LLM loop dispatches tool calls through the tool layer and keeps history append-only", async () => {
    // A scripted stand-in for the Messages API, to test the loop mechanics without network.
    const responses: Partial<Anthropic.Beta.BetaMessage>[] = [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "discover_sellers", input: {} } as Anthropic.Beta.BetaToolUseBlock] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "done", citations: null } as Anthropic.Beta.BetaTextBlock] },
    ];
    const seen: unknown[] = [];
    const client = {
      beta: {
        messages: {
          create: async (req: { messages: unknown[]; tools: unknown[] }) => {
            seen.push(structuredClone(req.messages));
            expect(req.tools).toEqual(TOOL_DEFS);
            return responses.shift();
          },
        },
      },
    } as unknown as Anthropic;
    const tools = stack.buyerTools();
    const run = await runLlmAgent(tools, "find sellers", { client });
    expect(run.finalText).toBe("done");
    expect(tools.transcript[0]!.tool).toBe("discover_sellers");
    // second request starts with exactly the first request's messages (append-only)
    expect((seen[1] as unknown[]).slice(0, 1)).toEqual(seen[0]);
  });

  it("MCP: lists exactly the seven buyer tools; the ones that spend are marked destructive", async () => {
    const { client } = await mcpClient(stack.buyerTools());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["call_service", "check_delivery", "close_session", "discover_sellers", "open_session", "propose", "request_quote"]);
    const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).sort();
    expect(destructive).toEqual(["call_service", "close_session", "open_session"]);
    expect(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort()).toEqual(["check_delivery", "discover_sellers"]);
    expect(client.getInstructions()).toMatch(/do not know the user's budget/);
    // nothing in the tool surface can read, write or reveal the mandate
    expect(JSON.stringify(tools)).not.toMatch(/mandate|budget_|seal|revoke|admin/i);
  });

  it("MCP: bad arguments and unknown tools are refused before any tool runs", async () => {
    const tools = stack.buyerTools();
    const { call } = await mcpClient(tools);
    expect((await call("propose", {})).isError).toBe(true);
    expect((await call("propose", { quote_id: "q", budget: "1" })).json.error).toMatch(/unexpected argument/);
    expect((await call("get_mandate")).json.error).toMatch(/unknown tool/);
    expect((await call("request_quote", { seller_url: stack.urls.honest1, service_id: 5 })).isError).toBe(true);
    expect(tools.transcript).toHaveLength(0);
  });

  it("MCP: a client buys end to end, is refused where it must be, and never sees the budget", async () => {
    const tools = stack.buyerTools();
    const { call } = await mcpClient(tools);
    const seen: string[] = [];
    const go = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await call(name, args);
      seen.push(r.text);
      return r;
    };

    const found = await go("discover_sellers");
    expect(found.isError).toBe(false);
    expect(await go("call_service", { session_id: "0x" + "00".repeat(32) })).toMatchObject({ isError: true }); // no such session: refused, nothing paid

    let q = await go("request_quote", { seller_url: stack.urls.honest2, service_id: "nav-snapshot" });
    expect(q.isError).toBe(false);
    let decision = "";
    for (let round = 0; round < 12 && decision !== "accept"; round++) {
      const d = await go("propose", { quote_id: q.json.quote_id as string });
      decision = d.json.decision as string;
      if (decision === "counter") q = await go("request_quote", { seller_url: stack.urls.honest2, service_id: "nav-snapshot", rfq_id: d.json.rfq_id as string, counter_offer: d.json.counter_offer as string });
      else if (decision !== "accept") break;
    }
    expect(decision).toBe("accept");

    const opened = await go("open_session", { quote_id: q.json.quote_id as string });
    expect(opened.isError).toBe(false);
    const sessionId = opened.json.session_id as string;
    for (let i = 0; i < 2; i++) expect((await go("call_service", { session_id: sessionId })).json.paid).toBe(true);
    expect((await go("check_delivery", { session_id: sessionId })).isError).toBe(false);
    const closed = await go("close_session", { session_id: sessionId });
    expect(closed.isError).toBe(false);
    expect(closed.json.receipt).toBeTruthy();

    // as standalone numbers: a public value like a token's totalSupply can contain these digits by chance
    const everything = seen.join("\n");
    const hasNumber = (n: bigint) => new RegExp(`(?<![0-9])${n}(?![0-9])`).test(everything);
    expect(hasNumber(stack.mandate.cap)).toBe(false);
    expect(hasNumber(stack.mandate.max)).toBe(false);
  }, 180_000);

  it.skipIf(!llmFromEnv(process.env))("live LLM buys a service end to end without seeing the budget", async () => {
    const tools = stack.buyerTools();
    const run = await runAgent(tools, `Buy 2 calls of the "recent-transfers" service from the seller at ${stack.urls.honest2}, then close the session.`, llmFromEnv(process.env)!, { log: (m) => console.log(m) });
    console.log("live agent tool calls:", tools.transcript.map((t) => `${t.tool}${"decision" in (t.output as object) ? `:${(t.output as { decision: string }).decision}` : ""}${"error" in (t.output as object) ? ":ERROR" : ""}`).join(" -> "));
    console.log("live agent final answer:", run.finalText.slice(0, 600));
    expect(tools.transcript.some((t) => t.tool === "close_session" && "receipt" in (t.output as object))).toBe(true);
    const everything = JSON.stringify(run.conversation) + JSON.stringify(tools.transcript);
    const hasNumber = (n: bigint) => new RegExp(`(?<![0-9])${n}(?![0-9])`).test(everything);
    expect(hasNumber(stack.mandate.cap)).toBe(false);
    expect(hasNumber(stack.mandate.max)).toBe(false);
  }, 900_000);
});
