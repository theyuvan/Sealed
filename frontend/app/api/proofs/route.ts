import { jsonError, vault } from "@/lib/backend";

export const dynamic = "force-dynamic";

/** The spend proofs the Vault has made: public signals by name, proving time, local verification. Owner view. */
export async function GET() {
  try {
    return Response.json(await vault("/proofs"));
  } catch (e) {
    return jsonError(e);
  }
}
