import { resolvePrincipal } from "@/lib/guard";

export async function GET(request: Request) {
  const principal = await resolvePrincipal(request);
  if (!principal) return Response.json({ error: "Нужен вход" }, { status: 401 });
  return Response.json({ email: principal.email, kind: principal.kind });
}
