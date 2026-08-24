import { tenantRoute } from "@/lib/guard";
import { listContacts } from "@/lib/calls";
async function handleGET() { return Response.json({ contacts: await listContacts() }); }

export const GET = tenantRoute(handleGET);
