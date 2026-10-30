import { coordinator, jsonError } from "@/lib/backend";

export const dynamic = "force-dynamic";

/** Every session the coordinator has an HSP order for, newest first. */
export async function GET() {
  try {
    return Response.json(await coordinator("/sessions"));
  } catch (e) {
    return jsonError(e);
  }
}
