import { listContacts } from "@/lib/calls";
export async function GET() { return Response.json({ contacts: await listContacts() }); }
