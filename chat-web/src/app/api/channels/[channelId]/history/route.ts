import { getRequestSession } from "@/server/auth";
import { loadChannelHistoryPage, UnknownChannelError } from "@/server/data";

export const dynamic = "force-dynamic";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_ID = /^[0-9a-f]{64}$/i;

type RouteProps = { params: Promise<{ channelId: string }> };

export async function GET(
  request: Request,
  { params }: RouteProps,
): Promise<Response> {
  const session = getRequestSession(request);
  if (!session) {
    return Response.json(
      { error: "Login required" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  const { channelId } = await params;
  const url = new URL(request.url);
  const createdAt = Number(url.searchParams.get("created_at"));
  const id = url.searchParams.get("id") ?? "";
  if (
    !UUID.test(channelId) ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    !EVENT_ID.test(id)
  ) {
    return Response.json(
      { error: "Invalid channel history cursor" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const page = await loadChannelHistoryPage(
      session,
      channelId,
      { createdAt, id },
      url.searchParams.get("fresh") === "1",
    );
    return Response.json(page, {
      headers: {
        "Cache-Control": "private, no-cache",
        "X-Buzz-Cache": page.cacheState,
      },
    });
  } catch (error) {
    if (error instanceof UnknownChannelError) {
      return Response.json(
        { error: "Channel not found" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    console.error("web channel history failed", error);
    return Response.json(
      { error: "Older messages are temporarily unavailable" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
