import { externalCallRoute } from "@/lib/guard";
import { getCallRecord, getContact, listCallTranscript } from "@/lib/calls";

async function handleGET(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const call = await getCallRecord(id);
  if (!call) return Response.json({ error: "Звонок не найден" }, { status: 404 });
  const contactId = `phone:${call.phone.trim() || "unknown"}`;
  return Response.json({ call, contact: await getContact(contactId), messages: await listCallTranscript(call.id) });
}

export const GET = externalCallRoute(handleGET);
