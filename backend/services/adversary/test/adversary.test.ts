import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, seededRng, startPolicy } from "@sealed/core";
import { baselineTrace, estimateCeilingBaselineAware, evaluate, evaluateRecorded, probeInterval, sealedTrace } from "../src/adversary.ts";
import { renderChartSvg } from "../src/chart.ts";

describe("adversary evaluator", () => {
  it("baseline trajectory reveals the budget exactly to an algorithm-aware adversary", () => {
    const t = baselineTrace(10_000_000n, () => 100_000_000n);
    expect(t.offers.at(-1)).toBe(10_000_000n);
    expect(Math.round(estimateCeilingBaselineAware(t.offers))).toBe(10_000_000);
  });

  it("sealed offers never exceed the ceiling", () => {
    const rng = seededRng(3);
    for (let i = 0; i < 200; i++) {
      for (const o of sealedTrace(10_000_000n, () => 100_000_000n, rng).offers) expect(o <= 10_000_000n).toBe(true);
    }
  });

  it("Sealed raises the adversary's inference error well above the baseline", () => {
    const r = evaluate({ runs: 1000, seed: 9 });
    expect(r.baselineMapeAware).toBeLessThan(0.001);
    expect(r.sealedMapeAware).toBeGreaterThan(0.05);
    expect(r.sealedMapeGeneric).toBeGreaterThan(r.baselineMape);
  });

  it("binary-search probing pins a baseline budget but not a sealed one under the probe limits", () => {
    const theta = 20_000_000n;
    const base = probeInterval((q) => q <= theta, 100_000_000n, 40, 40);
    expect(Number(base.hi - base.lo)).toBeLessThan(1_000);
    expect(base.lo <= theta && theta <= base.hi).toBe(true);

    // Sealed: fresh hidden target per negotiation; at most 3 negotiations per seller and 9 rounds each
    let totalErr = 0;
    const trials = 300;
    const rng = seededRng(5);
    for (let k = 0; k < trials; k++) {
      const targets = [0, 1, 2].map(() => startPolicy(theta, rng, DEFAULT_POLICY).target);
      const r = probeInterval((q, neg) => q <= targets[Math.min(neg, 2)]!, 100_000_000n, 27, 9);
      totalErr += Math.abs(Number((r.lo + r.hi) / 2n - theta)) / Number(theta);
    }
    expect(totalErr / trials).toBeGreaterThan(0.05);
  });

  it("scores recorded Vault traces", () => {
    const r = evaluateRecorded(
      [
        { negotiationId: "a", offer: "5000000" },
        { negotiationId: "a", offer: "7000000" },
        { negotiationId: "b", offer: null },
      ],
      10_000_000n,
    );
    expect(r.negotiations).toBe(1);
    expect(r.mape).toBeGreaterThan(0);
  });
});

describe("demo chart", () => {
  it("renders the measured errors as a self-contained SVG", () => {
    const r = evaluate({ runs: 200, seed: 3 });
    const svg = renderChartSvg(r);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain(`${(r.sealedMapeAware * 100).toFixed(1)}%`);
    expect(svg).toContain(`${(r.baselineMapeAware * 100).toFixed(1)}%`);
    expect(svg).not.toMatch(/NaN|undefined/);
    expect(svg.endsWith("</svg>\n")).toBe(true);
  });
});
