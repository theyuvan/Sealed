import { randomBytes } from "node:crypto";

/**
 * Randomized concession policy (README F4). Runs only inside the Vault; the buyer LLM sees only
 * `decision` and `offer`.
 *
 *   theta = min(maxRemaining, perDealCap)
 *   T ~ U[theta(1-alpha), theta]           hidden target, fresh per negotiation
 *   R ~ U{rMin..rMax}                      walk-away round
 *   o_t = clip(T s(t) + Laplace(0, b), floor, T)   s from a random curve family
 *   accept q  iff  q <= T
 */

export type Rng = () => number;

/** Uniform [0,1) from the OS CSPRNG. */
export const cryptoRng: Rng = () => randomBytes(6).readUIntBE(0, 6) / 2 ** 48;

/** Deterministic RNG for tests and the adversary simulations (mulberry32). */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Curve = "linear" | "concave" | "convex";

export interface PolicyParams {
  alpha: number;
  rMin: number;
  rMax: number;
  /** Laplace scale as a fraction of T */
  noise: number;
  /** first-offer fraction of T is drawn from [startMin, startMax] */
  startMin: number;
  startMax: number;
}

export const DEFAULT_POLICY: PolicyParams = { alpha: 0.25, rMin: 4, rMax: 9, noise: 0.04, startMin: 0.4, startMax: 0.7 };

export interface PolicyState {
  target: bigint;
  walkRound: number;
  curve: Curve;
  start: number;
  round: number;
  lastOffer: bigint;
  done: boolean;
}

export type PolicyDecision = { decision: "accept"; offer?: undefined } | { decision: "counter"; offer: bigint } | { decision: "walk"; offer?: undefined };

function uniformInt(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function laplace(rng: Rng, b: number): number {
  const u = rng() - 0.5;
  return -b * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

function shape(curve: Curve, x: number): number {
  if (curve === "concave") return 1 - (1 - x) ** 2;
  if (curve === "convex") return x * x;
  return x;
}

export function startPolicy(theta: bigint, rng: Rng = cryptoRng, p: PolicyParams = DEFAULT_POLICY): PolicyState {
  if (theta <= 0n) throw new Error("nothing to spend");
  const lo = Number(theta) * (1 - p.alpha);
  const target = BigInt(Math.floor(lo + rng() * (Number(theta) - lo)));
  const curves: Curve[] = ["linear", "concave", "convex"];
  return {
    target: target < 1n ? 1n : target > theta ? theta : target,
    walkRound: uniformInt(rng, p.rMin, p.rMax),
    curve: curves[Math.floor(rng() * curves.length)]!,
    start: p.startMin + rng() * (p.startMax - p.startMin),
    round: 0,
    lastOffer: 0n,
    done: false,
  };
}

/** Evaluate one seller quote. Mutates state. */
export function respond(state: PolicyState, quote: bigint, rng: Rng = cryptoRng, p: PolicyParams = DEFAULT_POLICY): PolicyDecision {
  if (state.done) return { decision: "walk" };
  state.round += 1;
  if (quote > 0n && quote <= state.target) {
    state.done = true;
    return { decision: "accept" };
  }
  if (state.round >= state.walkRound) {
    state.done = true;
    return { decision: "walk" };
  }
  const T = Number(state.target);
  const s = state.start + (1 - state.start) * shape(state.curve, state.round / state.walkRound);
  let o = BigInt(Math.round(T * s + laplace(rng, p.noise * T)));
  const floor = state.lastOffer > 0n ? state.lastOffer : 1n;
  if (o < floor) o = floor;
  if (o > state.target) o = state.target;
  state.lastOffer = o;
  return { decision: "counter", offer: o };
}
