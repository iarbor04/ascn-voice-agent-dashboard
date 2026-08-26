import { externalCallRoute } from "@/lib/guard";
import { listCallRecords } from "@/lib/calls";
import { dispatchOutboundCall, OutboundCallError } from "@/lib/outbound";

async function handleGET() {
  return Response.json({ calls: await listCallRecords() });
}

async function handlePOST(request: Request) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  try {
    return Response.json({ call: await dispatchOutboundCall({
      toNumber: typeof body?.toNumber === "string" ? body.toNumber : "",
      agentId: typeof body?.agentId === "string" ? body.agentId : "",
      connectionId: typeof body?.connectionId === "string" ? body.connectionId : "",
      variables: body?.variables,
    }) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не удалось начать звонок";
    return Response.json({
      ...(error instanceof OutboundCallError && error.call ? { call: error.call } : {}),
      error: message,
    }, { status: error instanceof OutboundCallError ? error.status : 500 });
  }
}

export const GET = externalCallRoute(handleGET);
export const POST = externalCallRoute(handlePOST);
