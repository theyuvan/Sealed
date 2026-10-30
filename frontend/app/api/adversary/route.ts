import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const dynamic = "force-dynamic";

/** The adversary evaluator's last report (`npm run adversary` writes backend/data/adversary-report.json). */
export async function GET() {
  const file = join(resolve(process.cwd(), ".."), "backend", "data", "adversary-report.json");
  if (!existsSync(file)) return Response.json({ error: "no report yet: run the adversary evaluator in backend" }, { status: 404 });
  return Response.json(JSON.parse(readFileSync(file, "utf8")));
}
