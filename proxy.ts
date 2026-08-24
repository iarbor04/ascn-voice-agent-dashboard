import { NextResponse, type NextRequest } from "next/server";
import { verifyAdmin } from "@/lib/admin";

export function proxy(request: NextRequest) {
  const machinePaths = ["/api/voice/runtime", "/api/voice/calls"];
  if (machinePaths.some((path) => request.nextUrl.pathname === path || request.nextUrl.pathname.startsWith(`${path}/`)) && process.env.INTERNAL_API_KEY && request.headers.get("authorization") === `Bearer ${process.env.INTERNAL_API_KEY}`) return NextResponse.next();
  if (!process.env.ADMIN_PASSWORD || verifyAdmin(request.headers)) return NextResponse.next();
  return new NextResponse("Authentication required", { status: 401, headers: { "www-authenticate": 'Basic realm="ASCN Voice"' } });
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"] };
