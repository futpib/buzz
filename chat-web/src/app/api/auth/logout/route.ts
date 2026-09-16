import { NextResponse } from "next/server";

import {
  assertSameOrigin,
  destroyRequestSession,
  getRequestSession,
} from "@/server/auth";
import { SESSION_COOKIE } from "@/shared/auth";

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    if (!getRequestSession(request)) {
      return Response.json({ error: "Login required" }, { status: 401 });
    }
    destroyRequestSession(request);
    const response = NextResponse.json({ ok: true });
    response.cookies.set(SESSION_COOKIE, "", {
      expires: new Date(0),
      httpOnly: true,
      path: "/",
      sameSite: "strict",
    });
    return response;
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Logout failed" },
      { status: 400 },
    );
  }
}
