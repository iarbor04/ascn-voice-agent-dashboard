import { SESSION_COOKIE, sessionToken } from "@/lib/guard";
import { destroySession } from "@/lib/tenants";

export async function POST(request: Request) {
  const token = sessionToken(request);
  if (token) await destroySession(token);
  return Response.json({ ok: true }, { headers: { "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` } });
}
