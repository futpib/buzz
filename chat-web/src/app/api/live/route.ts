import { getRequestSession } from "@/server/auth";
import { loadChannelSnapshot, markWorkspaceViewsStale } from "@/server/data";
import { channelLiveStream } from "@/server/channel-live-stream";
import { listenForChannelChanges } from "@/server/live";

export const dynamic = "force-dynamic";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_ID = /^[0-9a-f]{64}$/i;

export async function GET(request: Request): Promise<Response> {
  const session = getRequestSession(request);
  if (!session) {
    return Response.json({ error: "Login required" }, { status: 401 });
  }
  const url = new URL(request.url);
  const channelId = url.searchParams.get("channel") ?? "";
  const rootParam = url.searchParams.get("thread");
  const rootId = rootParam && EVENT_ID.test(rootParam) ? rootParam : null;
  if (!UUID.test(channelId) || (rootParam && !rootId)) {
    return Response.json(
      { error: "invalid live subscription target" },
      { status: 400 },
    );
  }

  const stream = channelLiveStream({
    signal: request.signal,
    load: () => loadChannelSnapshot(session, channelId, rootId),
    listen: (dirty, typing, signal) =>
      listenForChannelChanges(
        session,
        channelId,
        (catchUp) => {
          if (!catchUp) markWorkspaceViewsStale(session, channelId);
          dirty();
        },
        typing,
        signal,
      ),
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}
