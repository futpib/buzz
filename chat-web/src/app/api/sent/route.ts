import { getRequestSession } from "@/server/auth";
import { loadSentWorkspace, refreshSentWorkspace } from "@/server/sent";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = getRequestSession(request);
  if (!session) {
    return Response.json(
      { error: "Login required" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const fresh = new URL(request.url).searchParams.get("fresh") === "1";
    const view = fresh
      ? await refreshSentWorkspace(session)
      : await loadSentWorkspace(session);
    return Response.json(view, {
      headers: {
        "Cache-Control": "private, no-cache",
        "X-Buzz-Cache": view.cacheState,
      },
    });
  } catch (error) {
    console.error("web sent view failed", error);
    return Response.json(
      { error: "Sent messages are temporarily unavailable" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
