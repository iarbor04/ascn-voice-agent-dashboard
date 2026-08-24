import { verifyAdmin } from "@/lib/admin";
import { DEFAULT_TENANT, withTenant } from "@/lib/tenant-context";
import { sessionUser } from "@/lib/tenants";

export const SESSION_COOKIE = "ascn_session";

export function sessionToken(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([0-9a-f]{64})`));
  return match?.[1] || "";
}

export type Principal = { tenantId: string; email: string; kind: "session" | "admin" };

export async function resolvePrincipal(request: Request): Promise<Principal | null> {
  const token = sessionToken(request);
  if (token) {
    const user = await sessionUser(token);
    // У каждого пользователя свой тенант: id пользователя и есть id тенанта.
    if (user) return { tenantId: user.id, email: user.email, kind: "session" };
  }
  // Машинный ключ шлюза и автоматизаций принадлежит владельцу установки.
  const internal = process.env.INTERNAL_API_KEY?.trim();
  if (internal && request.headers.get("authorization") === `Bearer ${internal}`) {
    return { tenantId: DEFAULT_TENANT, email: "internal", kind: "admin" };
  }
  // Прежний админ из переменных окружения живёт в тенанте default —
  // существующая установка продолжает работать без миграции.
  if (!process.env.ADMIN_PASSWORD || verifyAdmin(request.headers)) {
    return { tenantId: DEFAULT_TENANT, email: process.env.ADMIN_USERNAME || "admin", kind: "admin" };
  }
  return null;
}

type Handler<C> = (request: Request, context: C) => Promise<Response> | Response;

export function tenantRoute<C>(handler: Handler<C>): Handler<C> {
  return async (request, context) => {
    const principal = await resolvePrincipal(request);
    if (!principal) return Response.json({ error: "Нужен вход" }, { status: 401 });
    return withTenant(principal.tenantId, () => handler(request, context));
  };
}
