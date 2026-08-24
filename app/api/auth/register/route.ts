import { SESSION_COOKIE } from "@/lib/guard";
import { createSession, rateLimited, registerUser, verifyUser } from "@/lib/tenants";

function clientIp(request: Request) {
  return (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "local";
}

export function sessionCookie(request: Request, token: string, maxAge: number) {
  const proto = request.headers.get("x-forwarded-proto") || new URL(request.url).protocol.replace(":", "");
  const secure = proto === "https" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export async function POST(request: Request) {
  if (rateLimited(clientIp(request))) return Response.json({ error: "Слишком много попыток — подождите десять минут" }, { status: 429 });
  const body = await request.json().catch(() => null) as { email?: string; password?: string } | null;
  try {
    const user = await registerUser(body?.email, String(body?.password || ""));
    const token = await createSession(user.id);
    return Response.json({ email: user.email }, { status: 201, headers: { "set-cookie": sessionCookie(request, token, 30 * 86400) } });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
}

// Вход держим в этом же модуле, чтобы куки собирались одинаково.
export async function PUT(request: Request) {
  if (rateLimited(clientIp(request))) return Response.json({ error: "Слишком много попыток — подождите десять минут" }, { status: 429 });
  const body = await request.json().catch(() => null) as { email?: string; password?: string } | null;
  const user = await verifyUser(body?.email, String(body?.password || ""));
  if (!user) return Response.json({ error: "Неверная почта или пароль" }, { status: 401 });
  const token = await createSession(user.id);
  return Response.json({ email: user.email }, { headers: { "set-cookie": sessionCookie(request, token, 30 * 86400) } });
}
