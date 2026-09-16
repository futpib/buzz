import { type NextRequest, NextResponse } from "next/server";

import { getSessionByToken } from "@/server/auth";
import { SESSION_COOKIE } from "@/shared/auth";

const PUBLIC_PATHS = new Set([
  "/login",
  "/api/auth/start",
  "/api/auth/session",
  "/api/auth/status",
]);

export function proxy(request: NextRequest): NextResponse {
  const path = request.nextUrl.pathname;
  if (
    PUBLIC_PATHS.has(path) ||
    path.startsWith("/_next/") ||
    path === "/icon.svg"
  ) {
    return NextResponse.next();
  }
  if (getSessionByToken(request.cookies.get(SESSION_COOKIE)?.value)) {
    return NextResponse.next();
  }
  if (path.startsWith("/api/")) {
    return NextResponse.json({ error: "Login required" }, { status: 401 });
  }
  const login = new URL("/login", request.url);
  login.searchParams.set("next", `${path}${request.nextUrl.search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
