import { getRequestSession } from "@/server/auth";
import { getServerConfig } from "@/server/env";
import {
  relayMediaTarget,
  validateMediaAuthorization,
} from "@/server/media-auth";

export const dynamic = "force-dynamic";

const FORWARDED_RESPONSE_HEADERS = [
  "accept-ranges",
  "content-length",
  "content-range",
  "content-type",
] as const;

export async function GET(request: Request): Promise<Response> {
  const session = getRequestSession(request);
  if (!session) {
    return Response.json(
      { error: "Login required" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const rawUrl = new URL(request.url).searchParams.get("url") ?? "";
    const target = relayMediaTarget(getServerConfig().relayHttpUrl, rawUrl);
    const authorization = request.headers.get("x-buzz-media-authorization");
    validateMediaAuthorization(authorization, session.pubkey, target);
    const headers = new Headers({ Authorization: authorization ?? "" });
    if (session.authTag) {
      headers.set("x-auth-tag", JSON.stringify(session.authTag));
    }
    const range = request.headers.get("range");
    if (range) headers.set("range", range);
    let upstream: Response;
    try {
      upstream = await fetch(target, {
        headers,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return Response.json(
        { error: "Media relay is unavailable" },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (!upstream.ok && upstream.status !== 206) {
      upstream.body?.cancel().catch(() => undefined);
      return Response.json(
        { error: "Media could not be loaded" },
        {
          status: upstream.status,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
    const responseHeaders = new Headers({
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'",
      "X-Content-Type-Options": "nosniff",
    });
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    const message =
      error instanceof Error && error.message.startsWith("Media URL")
        ? error.message
        : "Media authorization is invalid";
    return Response.json(
      { error: message },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
