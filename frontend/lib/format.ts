/** Token base units -> "12.50". */
export function usdc(units: string | bigint | number | undefined | null, decimals = 6): string {
  if (units === undefined || units === null || units === "") return "–";
  const v = BigInt(units);
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${v / base}.${frac}`;
}

export const short = (h: string | null | undefined, a = 8, b = 6) => (!h ? "–" : h.length <= a + b + 2 ? h : `${h.slice(0, a)}…${h.slice(-b)}`);

export const when = (ms: number) => new Date(ms).toLocaleString();
