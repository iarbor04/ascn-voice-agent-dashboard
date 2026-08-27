import { tenantRoute } from "@/lib/guard";
import { recordingResponse } from "@/lib/recording-stream";

async function handleGET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return recordingResponse(id, request.headers.get("range"));
}

export const GET = tenantRoute(handleGET);
