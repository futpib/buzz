import { createHash } from "node:crypto";
import {
  loadActivityWorkspace,
  refreshActivityWorkspace,
  markActivityViewsStale,
} from "@/server/activity";
import { getRequestSession } from "@/server/auth";
import { channelLiveStream } from "@/server/channel-live-stream";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = getRequestSession(request);
  if (!session)
    return Response.json({ error: "Login required" }, { status: 401 });
  const stream = channelLiveStream({
    signal: request.signal,
    load: async () => {
      const view = await refreshActivityWorkspace(session);
      const revision = createHash("sha256")
        .update(JSON.stringify([view.channels, view.items]))
        .digest("hex");
      return { ...view, revision };
    },
    listen: async (dirty, _typing, signal) => {
      const { channels } = await loadActivityWorkspace(session);
      const channelIds = channels.map((channel) => channel.id);
      const attempt = new AbortController();
      const subscriptionSignal = AbortSignal.any([signal, attempt.signal]);
      let remaining = channelIds.length ? 2 : 1;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const handlers = {
        onEose() {
          if (--remaining === 0) dirty();
        },
        onEvent(_event: unknown, live: boolean) {
          if (!live || timer) return;
          timer = setTimeout(() => {
            timer = undefined;
            markActivityViewsStale(session);
            dirty();
          }, 250);
        },
      };
      try {
        await Promise.all([
          session.relay.subscribe(
            {
              kinds: [43001, 43003, 43004],
              since: Math.floor(Date.now() / 1000) - 8,
            },
            handlers,
            subscriptionSignal,
          ),
          ...(channelIds.length
            ? [
                session.relay.subscribe(
                  {
                    kinds: [5, 9, 9005, 40002, 40003, 45001],
                    "#h": channelIds,
                    since: Math.floor(Date.now() / 1000) - 8,
                  },
                  handlers,
                  subscriptionSignal,
                ),
              ]
            : []),
        ]);
      } finally {
        clearTimeout(timer);
        attempt.abort();
      }
    },
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
