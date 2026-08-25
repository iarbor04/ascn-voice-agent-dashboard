import { NextResponse, type NextRequest } from "next/server";
import { verifyAdmin } from "@/lib/admin";

// Прокси решает только «пускать или нет». Кому какие данные — решают
// маршруты через tenantRoute: там сессия проверяется по хранилищу.
const PUBLIC_PATHS = ["/login", "/register", "/api/health"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const authorization = request.headers.get("authorization");
  if (pathname === "/api/voice/runtime" && process.env.GATEWAY_APP_KEY && authorization === `Bearer ${process.env.GATEWAY_APP_KEY}`) return NextResponse.next();
  if ((pathname === "/api/voice/calls" || pathname.startsWith("/api/voice/calls/")) && process.env.EXTERNAL_CALL_API_KEY && authorization === `Bearer ${process.env.EXTERNAL_CALL_API_KEY}`) return NextResponse.next();
  if (PUBLIC_PATHS.includes(pathname) || pathname.startsWith("/api/auth/")) return NextResponse.next();
  // Сессионная кука есть — пропускаем; действительна ли она, проверит маршрут.
  if (/(?:^|;\s*)ascn_session=[0-9a-f]{64}/.test(request.headers.get("cookie") || "")) return NextResponse.next();
  if (verifyAdmin(request.headers)) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Нужен вход" }, { status: 401 });
  // Людей ведём на страницу входа. Прежний Basic-запрос оставляем только
  // явному клиенту вроде curl: он присылает заголовок сам.
  if (request.headers.get("authorization")?.startsWith("Basic ")) {
    return new NextResponse("Authentication required", { status: 401, headers: { "www-authenticate": 'Basic realm="ASCN Voice"' } });
  }
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"] };
