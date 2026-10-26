import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { keccak256, stringToHex } from "viem";
import { canonicalJson } from "@sealed/core";
import { shutdownProver } from "@sealed/prover";
import { AGENT_TOKEN, startStack, type Stack } from "../../../tests/stack.ts";
import { TOOL_DEFS, checkDelivery, runLlmAgent, runScripted } from "../src/index.ts";

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

  it.skipIf(!process.env.ANTHROPIC_API_KEY && !process.env.LLM_API_KEY)("live LLM buys a service end to end without seeing the budget", async () => {
    const tools = stack.buyerTools();
    const run = await runLlmAgent(tools, `Buy 2 calls of the "recent-transfers" service from the seller at ${stack.urls.honest2}, then close the session.`, { apiKey: process.env.LLM_API_KEY });
    const everything = JSON.stringify(run.messages) + JSON.stringify(tools.transcript);
    expect(everything.includes(stack.mandate.cap.toString())).toBe(false);
    expect(everything.includes(stack.mandate.max.toString())).toBe(false);
  });
});
