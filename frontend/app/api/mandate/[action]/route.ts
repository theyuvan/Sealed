import { BackendError, jsonError, vault } from "@/lib/backend";

export async function POST(_req: Request, { params }: { params: Promise<{ action: string }> }) {
  try {
    const { action } = await params;
    if (action !== "revoke" && action !== "rotate") throw new BackendError("unknown action", 404);
    return Response.json(await vault(`/mandate/${action}`, { method: "POST", body: "{}", timeoutMs: 120_000 }));
  } catch (e) {
    return jsonError(e);
  }
}
