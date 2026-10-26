import { DEFAULT_POLICY, type PolicyParams, type Rng, respond, seededRng, startPolicy } from "@sealed/core";

/**
 * Budget-inference evaluator (README 9.5). A seller that never concedes watches the buyer's offer
 * trajectory and tries to infer the buyer's ceiling. We compare:
 *   baseline: budget B in the agent's context, standard monotone concession reaching B
 *   sealed:   the Vault's randomized policy (the same code the Vault runs)
 * The adversary knows each algorithm (Kerckhoffs): for Sealed it also gets a calibrated estimator
 * that corrects for the known target distribution. Results are reported as measured.
 */

export interface Trace {
  offers: bigint[];
  accepted: boolean;
}

/** Baseline buyer: offer_t = B * (s0 + (1 - s0) * t / R), accept iff quote <= B. */
export function baselineTrace(budget: bigint, sellerQuote: (round: number) => bigint, o: { start?: number; rounds?: number } = {}): Trace {
  const s0 = o.start ?? 0.6;
  const R = o.rounds ?? 8;
  const offers: bigint[] = [];
  for (let t = 1; t <= R; t++) {
    const q = sellerQuote(t);
    if (q <= budget) return { offers, accepted: true };
    offers.push(BigInt(Math.round(Number(budget) * (s0 + ((1 - s0) * t) / R))));
  }
  return { offers, accepted: false };
}

/** Sealed buyer: the Vault policy with theta = min(maxRemaining, perDealCap). */
export function sealedTrace(theta: bigint, sellerQuote: (round: number) => bigint, rng: Rng, p: PolicyParams = DEFAULT_POLICY): Trace {
  const st = startPolicy(theta, rng, p);
  const offers: bigint[] = [];
  for (let t = 1; ; t++) {
    const d = respond(st, sellerQuote(t), rng, p);
    if (d.decision === "accept") return { offers, accepted: true };
    if (d.decision === "walk") return { offers, accepted: false };
    offers.push(d.offer);
  }
}

/** Generic estimator: the ceiling is at least the last offer; extrapolate the concession trend one round. */
export function estimateCeiling(offers: bigint[]): number {
  if (offers.length === 0) return NaN;
  const ys = offers.map(Number);
  const last = ys.at(-1)!;
  if (ys.length < 2) return last;
  const n = ys.length;
  const xs = ys.map((_, i) => i + 1);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i]! - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  // a buyer that stopped conceding has reached its ceiling; otherwise project one more step
  return Math.max(last, last + Math.max(0, slope) * (ys.length >= 3 && ys[n - 1] === ys[n - 2] ? 0 : 1));
}

/** Estimator that also knows the Sealed policy: E[T/theta] = 1 - alpha/2, offers are capped at T. */
export function estimateCeilingSealedAware(offers: bigint[], p: PolicyParams = DEFAULT_POLICY): number {
  return estimateCeiling(offers) / (1 - p.alpha / 2);
}

/** Estimator that knows the baseline algorithm: any single offer reveals B exactly. */
export function estimateCeilingBaselineAware(offers: bigint[], o: { start?: number; rounds?: number } = {}): number {
  if (offers.length === 0) return NaN;
  const s0 = o.start ?? 0.6;
  const R = o.rounds ?? 8;
  return Number(offers[0]!) / (s0 + (1 - s0) / R);
}

export interface EvalResult {
  runs: number;
  baselineMape: number;
  baselineMapeAware: number;
  sealedMapeGeneric: number;
  sealedMapeAware: number;
  /** relative increase of the adversary's error (aware estimator vs baseline) */
  note: string;
}

const ape = (est: number, truth: bigint) => Math.abs(est - Number(truth)) / Number(truth);

/**
 * Simulates `runs` negotiations against a seller that never concedes (quotes 10x the ceiling), so
 * the adversary sees the full trajectory every time — the worst case for the buyer.
 */
export function evaluate(o: { runs?: number; seed?: number; ceilings?: [bigint, bigint] } = {}): EvalResult {
  const runs = o.runs ?? 500;
  const rng = seededRng(o.seed ?? 1);
  const [lo, hi] = o.ceilings ?? [5_000_000n, 50_000_000n];
  let b = 0;
  let ba = 0;
  let g = 0;
  let a = 0;
  for (let i = 0; i < runs; i++) {
    const ceiling = lo + BigInt(Math.floor(rng() * Number(hi - lo)));
    const neverConcede = () => ceiling * 10n;
    const base = baselineTrace(ceiling, neverConcede).offers;
    b += ape(estimateCeiling(base), ceiling);
    ba += ape(estimateCeilingBaselineAware(base), ceiling);
    const s = sealedTrace(ceiling, neverConcede, rng).offers;
    g += ape(estimateCeiling(s), ceiling);
    a += ape(estimateCeilingSealedAware(s), ceiling);
  }
  const r = { runs, baselineMape: b / runs, baselineMapeAware: ba / runs, sealedMapeGeneric: g / runs, sealedMapeAware: a / runs };
  return {
    ...r,
    note:
      `Adversary error on the budget ceiling (mean absolute % error). Algorithm-aware adversary: baseline ${(r.baselineMapeAware * 100).toFixed(1)}%, Sealed ${(r.sealedMapeAware * 100).toFixed(1)}%. ` +
      `Generic trend estimator: baseline ${(r.baselineMape * 100).toFixed(1)}%, Sealed ${(r.sealedMapeGeneric * 100).toFixed(1)}%. Sealed reduces, not eliminates, behavioral leakage.`,
  };
}

/** Evaluate recorded Vault traces (counter-offers per negotiation) against the true ceiling. */
export function evaluateRecorded(traces: { negotiationId: string; offer: string | null }[], trueCeiling: bigint) {
  const byNeg = new Map<string, bigint[]>();
  for (const t of traces) {
    if (!t.offer) continue;
    const arr = byNeg.get(t.negotiationId) ?? [];
    arr.push(BigInt(t.offer));
    byNeg.set(t.negotiationId, arr);
  }
  const errs = [...byNeg.values()].filter((o) => o.length > 0).map((o) => ape(estimateCeilingSealedAware(o), trueCeiling));
  return { negotiations: errs.length, mape: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : NaN };
}

/**
 * Binary-search prober (rogue attack 3): how close can a prober get to the ceiling with a given
 * number of accept/reject answers? Baseline answers are deterministic (q <= B); Sealed answers
 * use a fresh hidden target per negotiation and the Vault's probe limits cap the answers.
 */
export function probeInterval(answer: (q: bigint, negotiation: number) => boolean, upper: bigint, evaluations: number, perNegotiation: number): { lo: bigint; hi: bigint } {
  let lo = 0n;
  let hi = upper;
  for (let i = 0; i < evaluations; i++) {
    const mid = (lo + hi) / 2n;
    if (answer(mid, Math.floor(i / perNegotiation))) lo = mid;
    else hi = mid;
  }
  return { lo, hi };
}
