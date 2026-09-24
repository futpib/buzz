import { getRequestSession } from "@/server/auth";
import { loadWorkspaceIndex } from "@/server/data";
import {
  markNavigationViewsStale,
  NAVIGATION_APP_DATA_KIND,
  NAVIGATION_MESSAGE_KINDS,
  loadNavigationWorkspace,
  refreshNavigationWorkspace,
} from "@/server/navigation";
import type { NavigationWorkspaceView, NostrEvent } from "@/server/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = getRequestSession(request);
  if (!session) {
    return Response.json({ error: "Login required" }, { status: 401 });
  }

  const [initial, workspace] = await Promise.all([
    loadNavigationWorkspace(session),
    loadWorkspaceIndex(session),
  ]);
  const channelIds = workspace.channels
    .filter((channel) => !channel.archived)
    .map((channel) => channel.id);
  const encoder = new TextEncoder();
  const abort = new AbortController();
  let stopped = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let current: NavigationWorkspaceView = initial;
  let refreshInFlight = false;
  let refreshPending = false;
  let pendingLiveEvent: NostrEvent | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: string, data: unknown) => {
        if (stopped) return;
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };
      const refresh = async (
        liveEvent: NostrEvent | null = null,
        retry = 0,
      ) => {
        if (refreshInFlight) {
          refreshPending = true;
          if (liveEvent) pendingLiveEvent = liveEvent;
          return;
        }
        refreshInFlight = true;
        try {
          markNavigationViewsStale(session);
          const previousIds = new Set(
            current.candidates.map((candidate) => candidate.id),
          );
          current = await refreshNavigationWorkspace(session);
          emit("snapshot", current);
          if (liveEvent && liveEvent.kind !== NAVIGATION_APP_DATA_KIND) {
            for (const candidate of current.candidates) {
              if (!previousIds.has(candidate.id)) emit("candidate", candidate);
            }
          }
          emit("status", { state: "live" });
        } catch (error) {
          emit("status", {
            state: "degraded",
            message: error instanceof Error ? error.message : "refresh failed",
          });
          if (liveEvent && retry < 3 && !stopped) {
            setTimeout(
              () => void refresh(liveEvent, retry + 1),
              1_000 * 2 ** retry,
            );
          }
        } finally {
          refreshInFlight = false;
          if (refreshPending) {
            refreshPending = false;
            const pending = pendingLiveEvent;
            pendingLiveEvent = null;
            void refresh(pending);
          }
        }
      };

      emit("status", { state: "connecting" });
      emit("snapshot", initial);
      let catchingUp = channelIds.length > 0 ? 2 : 1;
      const handlers = {
        onEose() {
          catchingUp -= 1;
          if (catchingUp === 0) void refresh();
        },
        onEvent(event: NostrEvent, isLive: boolean) {
          if (isLive) void refresh(event);
        },
      };
      const subscriptions = [
        session.relay.subscribe(
          {
            kinds: [NAVIGATION_APP_DATA_KIND],
            authors: [session.pubkey],
            since: Math.floor(Date.now() / 1_000) - 8,
          },
          handlers,
          abort.signal,
        ),
      ];
      if (channelIds.length > 0) {
        subscriptions.push(
          session.relay.subscribe(
            {
              kinds: NAVIGATION_MESSAGE_KINDS,
              "#h": channelIds,
              since: Math.floor(Date.now() / 1_000) - 8,
            },
            handlers,
            abort.signal,
          ),
        );
      }
      void Promise.all(subscriptions).catch((error) => {
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
