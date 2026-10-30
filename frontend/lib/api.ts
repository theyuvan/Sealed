"use client";
import { useCallback, useEffect, useState } from "react";

/** Fetches JSON from our own route handlers; surfaces the backend's error text instead of hiding it. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, cache: "no-store", headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}

/** Polls a route while mounted. */
export function usePoll<T>(path: string, everyMs = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [path]);
  useEffect(() => {
    void reload();
    const t = setInterval(reload, everyMs);
    return () => clearInterval(t);
  }, [reload, everyMs]);
  return { data, error, reload };
}

export interface Overview {
  chainId: number;
  explorer: string;
  hspMode: string;
  decimals: number;
  probeLimit: number;
  services: { vault: boolean; coordinator: boolean; sellers: number; buyer: boolean };
  /** the buyer agent's LLM provider, or null when none is configured */
  llm: string | null;
  sellers: { url: string; name: string; address: string; services: { id: string; category: string; categoryId: number; calls: number; listPrice: string; description: string }[]; notice?: string }[];
  meta: {
    chainId: number;
    deployment: { registry: string; escrow: string; verifier: string; token: string; coordinator: string };
    categories: Record<string, number>;
    circuit: { protocol: string; curve: string; publicSignals: string[]; nPublic: number; variables: number | null; domainSize: number | null; zkeyBytes: number; wasmBytes: number; treeDepth: number; allowlistDepth: number };
  } | null;
  mandate: { active: boolean; evaluations: number; commitment: string | null; expiry: string | null; pendingSpend: boolean } | null;
  sessions: SessionRow[];
}

export interface SessionRow {
  sessionId: string;
  seller: string;
  amount: string;
  status: string;
  flowId: string | null;
  hspTx: string | null;
  fundTx: string | null;
  createdAt: number;
}

export interface ProofRecord {
  sessionId: string;
  seller: string;
  provingMs: number;
  verifiedLocally: boolean;
  createdAt: number;
  publicSignals: Record<string, string>;
  proof: unknown;
  rawPublicSignals: string[];
}
