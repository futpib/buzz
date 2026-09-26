import { eventThreadTarget } from "@/server/event-navigation";
import { projectMessages, projectProfiles } from "@/server/projector";
import {
  loadProjectionAuxClosure,
  type RelayQuery,
} from "@/server/projection-events";
import type { NostrEvent, PinnedMessageView, ThreadView } from "@/server/types";

const EVENT_ID = /^[0-9a-f]{64}$/i;

/** Project channel pins, excluding deleted pins/messages and cross-channel targets. */
export function projectPins(
  events: NostrEvent[],
  channelId: string,
  viewer: string,
): PinnedMessageView[] {
  const deleted = new Set(
    events
      .filter((event) => event.kind === 5 || event.kind === 9005)
      .flatMap((event) =>
        event.tags.filter((tag) => tag[0] === "e").map((tag) => tag[1]),
      ),
  );
  const messages = projectMessages(
    events,
    channelId,
    projectProfiles(events),
    viewer,
  );
  return messages
    .flatMap((message) => {
      const pins = events.filter(
        (event) =>
          event.kind === 40004 &&
          !deleted.has(event.id) &&
          event.tags.some((tag) => tag[0] === "h" && tag[1] === channelId) &&
          event.tags.some((tag) => tag[0] === "e" && tag[1] === message.id),
      );
      if (!pins.length) return [];
      const source = events.find((event) => event.id === message.id);
      if (!source) return [];
      return [
        {
          message,
          threadId: eventThreadTarget(source),
          ownPinIds: pins
            .filter((pin) => pin.pubkey === viewer)
            .map((pin) => pin.id),
          pinnedAt: Math.max(...pins.map((pin) => pin.created_at)),
        },
      ];
    })
    .sort(
      (a, b) =>
        b.pinnedAt - a.pinnedAt || a.message.id.localeCompare(b.message.id),
    );
}

/** Load pins independently of the current timeline window, including edit/deletion closure. */
export async function loadChannelPins(
  query: RelayQuery,
  channelId: string,
  viewer: string,
): Promise<PinnedMessageView[]> {
  const pins = await query([{ kinds: [40004], "#h": [channelId], limit: 500 }]);
  if (pins.length === 500)
    throw new Error("Channel pin history exceeds the supported window");
  const ids = [
    ...new Set(
      pins.flatMap((event) =>
        event.tags
          .filter((tag) => tag[0] === "e" && EVENT_ID.test(tag[1] ?? ""))
          .map((tag) => tag[1]),
      ),
    ),
  ];
  if (!ids.length) return [];
  const [messages, auxiliary] = await Promise.all([
    query([{ ids, "#h": [channelId], limit: ids.length }]),
    loadProjectionAuxClosure(query, channelId, [
      ...ids,
      ...pins.map((pin) => pin.id),
    ]),
  ]);
  const authors = [...new Set(messages.map((message) => message.pubkey))];
  const profiles = authors.length
    ? await query([{ kinds: [0], authors, limit: authors.length }])
    : [];
  return projectPins(
    [...pins, ...messages, ...auxiliary, ...profiles],
    channelId,
    viewer,
  );
}

/** Keep pinned replies reachable even when they predate the normal thread window. */
export function includePinnedReplies(
  thread: ThreadView,
  pins: PinnedMessageView[],
): ThreadView {
  const replies = new Map(
    thread.replies.map((message) => [message.id, message]),
  );
  for (const pin of pins) {
    if (
      pin.threadId === thread.rootId &&
      pin.message.id !== thread.rootId &&
      !replies.has(pin.message.id)
    ) {
      replies.set(pin.message.id, pin.message);
    }
  }
  return {
    ...thread,
    replies: [...replies.values()].sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    ),
  };
}
