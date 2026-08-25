import { SESSION_COOKIE } from "@/lib/guard";
import { verifyAdminCredentials } from "@/lib/admin";
import { rateLimit } from "@/lib/redis";
import { createAdminSession, createSession, registerUser, verifyUser } from "@/lib/tenants";

function clientIp(request: Request) {
  if (process.env.TRUST_PROXY !== "true") return null;
  const chain = (request.headers.get("x-forwarded-for") || "").split(",");
  return chain.at(-1)?.trim().slice(0, 64) || null;
}

function rateIdentity(value: unknown) {
  return String(value || "").trim().toLowerCase().slice(0, 200) || "unknown";
}

export function sessionCookie(request: Request, token: string, maxAge: number) {
  const forwardedProto = process.env.TRUST_PROXY === "true" ? request.headers.get("x-forwarded-proto") : "";
  const secure = process.env.NODE_ENV === "production" || forwardedProto === "https" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_PUBLIC_REGISTRATION !== "true") {
    return Response.json({ error: "Публичная регистрация отключена" }, { status: 403 });
  }
  const body = await request.json().catch(() => null) as { email?: string; password?: string } | null;
  const ip = clientIp(request);
  const [byIp, byEmail] = await Promise.all([
    ip ? rateLimit("register-ip", ip, 10, 10 * 60) : Promise.resolve({ limited: false, remaining: 10 }),
    rateLimit("register-email", rateIdentity(body?.email), 5, 10 * 60),
  ]);
  if (byIp.limited || byEmail.limited) return Response.json({ error: "Слишком много попыток — подождите десять минут" }, { status: 429 });
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
  const body = await request.json().catch(() => null) as { email?: string; password?: string } | null;
  const ip = clientIp(request);
  const byIp = ip ? await rateLimit("login-ip", ip, 20, 10 * 60) : { limited: false };
  if (byIp.limited) return Response.json({ error: "Слишком много попыток — подождите десять минут" }, { status: 429 });
  if (verifyAdminCredentials(body?.email, body?.password)) {
    const token = await createAdminSession();
    return Response.json({ email: process.env.ADMIN_USERNAME || "admin" }, { headers: { "set-cookie": sessionCookie(request, token, 30 * 86400) } });
  }
  const user = await verifyUser(body?.email, String(body?.password || ""));
  if (!user) {
    const byEmail = await rateLimit("login-email", rateIdentity(body?.email), 10, 10 * 60);
    if (byEmail.limited) return Response.json({ error: "Слишком много попыток — подождите десять минут" }, { status: 429 });
    return Response.json({ error: "Неверная почта или пароль" }, { status: 401 });
  }
  const token = await createSession(user.id);
  return Response.json({ email: user.email }, { headers: { "set-cookie": sessionCookie(request, token, 30 * 86400) } });
}
