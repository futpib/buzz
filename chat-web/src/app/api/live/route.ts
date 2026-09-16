import { getRequestSession } from "@/server/auth";
import { loadChannelSnapshot } from "@/server/data";
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

  const encoder = new TextEncoder();
  const abort = new AbortController();
  let stopped = false;
  let refreshInFlight = false;
  let refreshPending = false;
  let revision = "";
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: string, data: unknown) => {
        if (stopped) return;
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };
      const refresh = async () => {
        if (refreshInFlight) {
          refreshPending = true;
          return;
        }
        refreshInFlight = true;
        try {
          const snapshot = await loadChannelSnapshot(
            session,
            channelId,
            rootId,
          );
          if (snapshot.revision !== revision) {
            revision = snapshot.revision;
            emit("snapshot", snapshot);
          }
        } catch (error) {
          emit("status", {
            state: "degraded",
            message: error instanceof Error ? error.message : "refresh failed",
          });
        } finally {
          refreshInFlight = false;
          if (refreshPending) {
            refreshPending = false;
            void refresh();
          }
        }
      };

      emit("status", { state: "connecting" });
      void refresh();
      void listenForChannelChanges(
        session,
        channelId,
        () => void refresh(),
        abort.signal,
      ).catch((error) => {
        emit("status", {
          state: "degraded",
          message:
            error instanceof Error ? error.message : "live updates failed",
        });
      });
      heartbeat = setInterval(() => emit("ping", Date.now()), 15_000);
      request.signal.addEventListener(
        "abort",
        () => {
          stopped = true;
          abort.abort();
          if (heartbeat) clearInterval(heartbeat);
          controller.close();
        },
        { once: true },
      );
    },
    cancel() {
      stopped = true;
      abort.abort();
      if (heartbeat) clearInterval(heartbeat);
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
