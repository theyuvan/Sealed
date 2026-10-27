import type { EvalResult } from "./adversary.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Bar chart for the demo: how wrong an adversary is about the budget ceiling, for an agent that
 * holds the budget in its prompt (baseline) against Sealed. Self-contained SVG, no dependencies.
 * Values are mean absolute percentage errors from evaluate(); taller is better for the buyer.
 */
export function renderChartSvg(r: EvalResult): string {
  const groups = [
    { label: "Algorithm-aware adversary", baseline: r.baselineMapeAware, sealed: r.sealedMapeAware },
    { label: "Generic trend estimator", baseline: r.baselineMape, sealed: r.sealedMapeGeneric },
  ];
  const W = 760;
  const H = 440;
  const plot = { x: 80, y: 90, w: 640, h: 250 };
  const top = Math.max(0.1, Math.ceil(Math.max(...groups.flatMap((g) => [g.baseline, g.sealed])) * 10) / 10);
  const y = (v: number) => plot.y + plot.h - (v / top) * plot.h;
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = top * f;
    return `<line x1="${plot.x}" x2="${plot.x + plot.w}" y1="${y(v)}" y2="${y(v)}" stroke="#d9d9d9"/><text x="${plot.x - 10}" y="${y(v) + 4}" text-anchor="end" font-size="12" fill="#555">${Math.round(v * 100)}%</text>`;
  });

  const barW = 90;
  const groupW = plot.w / groups.length;
  const bars = groups.flatMap((g, i) => {
    const cx = plot.x + groupW * i + groupW / 2;
    const one = (v: number, x: number, fill: string, name: string) =>
      `<rect x="${x}" y="${y(v)}" width="${barW}" height="${plot.y + plot.h - y(v)}" fill="${fill}" rx="3"><title>${esc(name)}: ${pct(v)}</title></rect>` +
      `<text x="${x + barW / 2}" y="${y(v) - 8}" text-anchor="middle" font-size="14" font-weight="600" fill="#222">${pct(v)}</text>`;
    return [
      one(g.baseline, cx - barW - 8, "#c0392b", "Budget in the agent's prompt"),
      one(g.sealed, cx + 8, "#2a7f62", "Sealed"),
      `<text x="${cx}" y="${plot.y + plot.h + 24}" text-anchor="middle" font-size="13" fill="#222">${esc(g.label)}</text>`,
    ];
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Adversary error when inferring the budget ceiling">
<rect width="${W}" height="${H}" fill="#ffffff"/>
<text x="${plot.x}" y="34" font-size="20" font-weight="700" fill="#111">How wrong is an adversary about the budget?</text>
<text x="${plot.x}" y="58" font-size="13" fill="#555">Mean absolute error on the budget ceiling, ${r.runs} simulated negotiations. Higher means less leaked.</text>
${grid.join("\n")}
${bars.join("\n")}
<rect x="${plot.x}" y="${H - 52}" width="14" height="14" fill="#c0392b"/><text x="${plot.x + 22}" y="${H - 40}" font-size="13" fill="#222">Budget in the agent's prompt</text>
<rect x="${plot.x + 250}" y="${H - 52}" width="14" height="14" fill="#2a7f62"/><text x="${plot.x + 272}" y="${H - 40}" font-size="13" fill="#222">Sealed (randomized concession policy)</text>
<text x="${plot.x}" y="${H - 14}" font-size="12" fill="#666">Sealed reduces behavioral leakage; it does not eliminate it. The accepted price still reveals a lower bound.</text>
</svg>
`;
}
