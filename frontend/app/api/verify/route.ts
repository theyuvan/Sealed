import { jsonError, vault } from "@/lib/backend";

/** Re-checks a Groth16 proof against the verification key (the same check SpendVerifier makes on chain). */
export async function POST(req: Request) {
  try {
    const b = (await req.json()) as { proof: unknown; publicSignals: string[] };
    return Response.json(await vault("/circuit/verify", { method: "POST", body: JSON.stringify({ proof: b.proof, publicSignals: b.publicSignals }) }));
  } catch (e) {
    return jsonError(e);
  }
}
