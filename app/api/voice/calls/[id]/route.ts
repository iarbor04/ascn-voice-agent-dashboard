import { getCallRecord, getContact, listMessagesSince } from "@/lib/calls";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const call = await getCallRecord(id);
  if (!call) return Response.json({ error: "Звонок не найден" }, { status: 404 });
  const contactId = `phone:${call.phone.trim() || "unknown"}`;
  return Response.json({ call, contact: await getContact(contactId), messages: await listMessagesSince(contactId, call.createdAt) });
}
