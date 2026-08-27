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
  // Прежний админ из переменных окружения живёт в тенанте default —
  // существующая установка продолжает работать без миграции.
  if (verifyAdmin(request.headers)) {
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

// Отдельный ключ автоматизаций имеет ровно одну область: API звонков
// владельца установки. Он не является principal и не открывает остальные
// tenantRoute-маршруты.
export function externalCallRoute<C>(handler: Handler<C>): Handler<C> {
  return async (request, context) => {
    const principal = await resolvePrincipal(request);
    if (principal) return withTenant(principal.tenantId, () => handler(request, context));
    const expected = process.env.EXTERNAL_CALL_API_KEY?.trim();
    if (!expected || request.headers.get("authorization") !== `Bearer ${expected}`) {
      return Response.json({ error: "Нужен вход" }, { status: 401 });
    }
    return withTenant(DEFAULT_TENANT, () => handler(request, context));
  };
}
