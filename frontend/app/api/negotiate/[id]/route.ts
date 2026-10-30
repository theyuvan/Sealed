import { buyer, jsonError } from "@/lib/backend";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return Response.json(await buyer(`/runs/${encodeURIComponent((await params).id)}`));
  } catch (e) {
    return jsonError(e);
  }
}
