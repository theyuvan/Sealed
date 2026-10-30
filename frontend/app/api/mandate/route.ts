import { config, jsonError, vault } from "@/lib/backend";

export const dynamic = "force-dynamic";

/** Owner view of the mandate. The values are returned only with ?reveal=1, so the page can keep them masked. */
export async function GET(req: Request) {
  try {
    const s = await vault<Record<string, unknown>>("/mandate/status");
    if (new URL(req.url).searchParams.get("reveal") === "1") return Response.json(s);
    const { remaining: _r, perDealCap: _p, ...masked } = s;
    return Response.json(masked);
  } catch (e) {
    return jsonError(e);
  }
}

/** Seal a mandate: { maxUsdc, perDealUsdc, categories: number[], sellers: address[], days } -> token base units on chain. */
export async function POST(req: Request) {
  try {
    const b = (await req.json()) as { maxUsdc?: number; perDealUsdc?: number; categories?: number[]; sellers?: string[]; days?: number };
    const units = (x: unknown) => {
      const n = Number(x);
      if (!Number.isFinite(n) || n <= 0) throw new Error("amounts must be positive numbers");
      return (BigInt(Math.round(n * 1e6)) * 10n ** BigInt(config.decimals) / 10n ** 6n).toString();
    };
    const days = Number(b.days ?? 7);
    if (!(days > 0 && days <= 365)) throw new Error("days must be between 1 and 365");
    if (!b.categories?.length || !b.sellers?.length) throw new Error("pick at least one category and one seller");
    return Response.json(
      await vault("/mandate/seal", {
        method: "POST",
        timeoutMs: 120_000,
        body: JSON.stringify({
          maxAmount: units(b.maxUsdc),
          perDealCap: units(b.perDealUsdc),
          categories: b.categories,
          sellers: b.sellers,
          expiry: String(Math.floor(Date.now() / 1000) + Math.round(days * 86400)),
        }),
      }),
    );
  } catch (e) {
    return jsonError(e);
  }
}
