import { NextResponse } from "next/server";

import { assertSameOrigin, completeLogin } from "@/server/auth";
import type { NostrEvent } from "@/server/types";
import { SESSION_COOKIE } from "@/shared/auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const raw = await request.text();
    if (raw.length > 16 * 1024) throw new Error("Login proof is too large");
    const body = JSON.parse(raw) as {
      attemptId?: unknown;
      event?: unknown;
    };
    if (typeof body.attemptId !== "string" || !body.event) {
      throw new Error("Login proof is incomplete");
    }
    const { token, pubkey } = await completeLogin(
      body.attemptId,
      body.event as NostrEvent,
    );
    const response = NextResponse.json({ pubkey });
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      maxAge: 8 * 60 * 60,
      path: "/",
      sameSite: "strict",
      secure:
        request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ===
          "https" || new URL(request.url).protocol === "https:",
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Login failed" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
}
