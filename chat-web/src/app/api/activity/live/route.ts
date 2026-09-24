import {
  loadActivityWorkspace,
  markActivityViewsStale,
} from "@/server/activity";
import { projectActivityItems } from "@/server/activity-view";
import { getRequestSession } from "@/server/auth";
import type {
  ActivityItemView,
  ActivityWorkspaceView,
  NostrEvent,
  ProfileView,
} from "@/server/types";

export const dynamic = "force-dynamic";

const CHANNEL_ACTIVITY_KINDS = [5, 9, 9_005, 40_002, 40_003, 45_001];
const JOB_ACTIVITY_KINDS = [43_001, 43_003, 43_004];

export async function GET(request: Request): Promise<Response> {
  const session = getRequestSession(request);
  if (!session) {
    return Response.json({ error: "Login required" }, { status: 401 });
  }
  const initialView = await loadActivityWorkspace(session);
  const channelIds = initialView.channels.map((channel) => channel.id);

  const encoder = new TextEncoder();
  const abort = new AbortController();
  let stopped = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let currentView: ActivityWorkspaceView | null = initialView;
  const deletedIds = new Set<string>();
  const displacedItems = new Map<string, ActivityItemView | null>();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: string, data: unknown) => {
        if (stopped) return;
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };
      const itemKey = (item: ActivityItemView) =>
        `${item.channel?.id ?? "global"}:${item.conversationId}`;

      const emitCurrentView = () => {
        if (!currentView) return;
        currentView = {
          ...currentView,
          generatedAt: Date.now(),
          cacheState: "refreshed",
        };
        emit("snapshot", currentView);
        emit("status", { state: "live" });
      };

      const restoreDisplaced = (eventId: string): ActivityItemView | null => {
        let restored = displacedItems.get(eventId) ?? null;
        while (restored && deletedIds.has(restored.id)) {
          restored = displacedItems.get(restored.id) ?? null;
        }
        return restored;
      };

      const applyLiveEvent = (event: NostrEvent) => {
        if (!currentView) return;

        if (event.kind === 5 || event.kind === 9_005) {
          const targets = event.tags
            .filter((tag) => tag[0] === "e" && typeof tag[1] === "string")
            .map((tag) => tag[1]);
          if (targets.length === 0) return;
          let items = currentView.items;
          for (const target of targets) {
            deletedIds.add(target);
            const current = items.find((item) => item.id === target);
            if (!current) continue;
            items = items.filter((item) => item.id !== target);
            const restored = restoreDisplaced(target);
            if (restored) items = [...items, restored];
          }
          currentView = {
            ...currentView,
            items: items.sort(
              (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
            ),
          };
          emitCurrentView();
          return;
        }

        if (event.kind === 40_003) {
          const target = event.tags.find(
            (tag) => tag[0] === "e" && typeof tag[1] === "string",
          )?.[1];
          if (!target) return;
          currentView = {
            ...currentView,
            items: currentView.items.map((item) =>
              item.id === target ? { ...item, content: event.content } : item,
            ),
          };
          emitCurrentView();
          return;
        }

        const knownAuthor =
          event.pubkey === currentView.identity.pubkey
            ? currentView.identity
            : currentView.items.find(
                (item) => item.author.pubkey === event.pubkey,
              )?.author;
        const profiles = new Map<string, ProfileView>();
        if (knownAuthor) profiles.set(event.pubkey, knownAuthor);
        const projected = projectActivityItems(
          [event],
          currentView.channels,
          profiles,
          session.pubkey,
        )[0];
        if (!projected) return;
        const key = itemKey(projected);
        const displaced =
          currentView.items.find((item) => itemKey(item) === key) ?? null;
        displacedItems.set(projected.id, displaced);
        currentView = {
          ...currentView,
          items: [
            {
              ...projected,
              itemCount: (displaced?.itemCount ?? 0) + projected.itemCount,
            },
            ...currentView.items.filter((item) => itemKey(item) !== key),
          ]
            .sort(
              (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
            )
            .slice(0, 100),
        };
        emitCurrentView();
      };

      emit("status", { state: "connecting" });
      let subscriptionsCatchingUp = channelIds.length > 0 ? 2 : 1;
      const handlers = {
        onEose() {
          subscriptionsCatchingUp -= 1;
          if (subscriptionsCatchingUp === 0) {
            emit("status", { state: "live" });
          }
        },
        onEvent(event: NostrEvent, isLive: boolean) {
          if (isLive) {
            markActivityViewsStale(session);
            applyLiveEvent(event);
          }
        },
      };
      const subscriptions = [
        session.relay.subscribe(
          {
            kinds: JOB_ACTIVITY_KINDS,
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
              kinds: CHANNEL_ACTIVITY_KINDS,
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
