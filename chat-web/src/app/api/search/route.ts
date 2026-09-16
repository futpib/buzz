import { getRequestSession } from "@/server/auth";
import { searchWorkspace } from "@/server/search";

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
    const query = new URL(request.url).searchParams.get("q") ?? "";
    return Response.json(await searchWorkspace(session, query), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Search query must")
    ) {
      return Response.json(
        { error: error.message },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    console.error("web search failed", error);
    return Response.json(
      { error: "Search is temporarily unavailable" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
