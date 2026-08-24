import { tenantRoute } from "@/lib/guard";
import { getContact, listCallMessages } from "@/lib/calls";
async function handleGET(_: Request, context: { params: Promise<{ id: string }> }) { const { id } = await context.params; const contact = await getContact(id); if (!contact) return Response.json({ error: "Звонок не найден" }, { status: 404 }); return Response.json({ contact, messages: await listCallMessages(id) }); }

export const GET = tenantRoute(handleGET);
