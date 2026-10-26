import { z } from "zod";
import { CATEGORIES, type CategoryName } from "./note.ts";

/** Data products sellers offer (README 9.3). Prices are token base units for all `calls`. */
export interface CatalogItem {
  id: string;
  category: CategoryName;
  calls: number;
  description: string;
}

export const CATALOG: CatalogItem[] = [
  { id: "nav-snapshot", category: "data.nav", calls: 5, description: "On-chain supply snapshot of a tokenized asset (NAV inputs; no price oracle)" },
  { id: "holder-distribution", category: "data.holders", calls: 5, description: "Top holders seen in recent Transfer logs with current balances" },
  { id: "recent-transfers", category: "data.transfers", calls: 5, description: "Most recent Transfer events of a tokenized asset" },
];

export function categoryId(name: CategoryName): number {
  return CATEGORIES[name];
}

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uintStr = z.string().regex(/^\d+$/);

const envelope = <T extends z.ZodTypeAny>(service: string, data: T) =>
  z
    .object({
      service: z.literal(service),
      sessionId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      call: z.number().int().positive(),
      chainId: z.number().int(),
      block: uintStr,
      data,
    })
    .strict();

/** Deterministic JSON schemas the buyer checks every delivery against before paying. */
export const DELIVERY_SCHEMAS: Record<string, z.ZodTypeAny> = {
  "nav-snapshot": envelope(
    "nav-snapshot",
    z.array(z.object({ asset: addr, symbol: z.string(), decimals: z.number().int(), totalSupply: uintStr }).strict()).min(1),
  ),
  "holder-distribution": envelope(
    "holder-distribution",
    z.array(z.object({ asset: addr, holders: z.array(z.object({ address: addr, balance: uintStr }).strict()) }).strict()).min(1),
  ),
  "recent-transfers": envelope(
    "recent-transfers",
    z.array(z.object({ asset: addr, transfers: z.array(z.object({ from: addr, to: addr, value: uintStr, block: uintStr, tx: z.string() }).strict()) }).strict()).min(1),
  ),
};
