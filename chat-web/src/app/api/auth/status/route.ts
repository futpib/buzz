import { getRequestSession } from "@/server/auth";

export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  const session = getRequestSession(request);
  return session
    ? Response.json(
        { authenticated: true, pubkey: session.pubkey },
        { headers: { "Cache-Control": "no-store" } },
      )
    : Response.json(
        { authenticated: false },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
}
