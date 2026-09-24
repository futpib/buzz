import { fallbackProfile } from "@/server/projector";
import type {
  ChannelView,
  NavigationCandidateView,
  NostrEvent,
  ProfileView,
} from "@/server/types";

const MESSAGE_KINDS = new Set([9, 40_002, 40_008, 45_001, 45_003]);

function tagValue(event: NostrEvent, key: string): string | null {
  return (
    event.tags.find(
      (tag) => tag[0] === key && typeof tag[1] === "string",
    )?.[1] ?? null
  );
}

function threadReference(event: NostrEvent): {
  rootId: string | null;
  parentId: string | null;
} {
  const references = event.tags.filter(
    (tag) => tag[0] === "e" && typeof tag[1] === "string",
  );
  const root = references.find((tag) => tag[3] === "root")?.[1] ?? null;
  const reply = references.find((tag) => tag[3] === "reply")?.[1] ?? null;
  const legacy = references[0]?.[1] ?? null;
  return {
    rootId: root ?? reply ?? legacy,
    parentId: reply ?? legacy,
  };
}

function highPriority(event: NostrEvent, viewerPubkey: string): boolean {
  const normalized = viewerPubkey.toLowerCase();
  return event.tags.some(
    (tag) =>
      (tag[0] === "p" && tag[1]?.toLowerCase() === normalized) ||
      (tag[0] === "broadcast" && tag[1] === "1"),
  );
}

/**
 * Project relay messages into the bounded navigation/unread shape consumed by
 * the browser. React never receives raw channel events or reconstructs thread
 * semantics from Nostr tags.
 */
export function projectNavigationCandidates(
  events: NostrEvent[],
  channels: ChannelView[],
  profiles: Map<string, ProfileView>,
  viewerPubkey: string,
): NavigationCandidateView[] {
  const channelsById = new Map(
    channels.map((channel) => [channel.id, channel]),
  );
  const deleted = new Set<string>();
  for (const event of events) {
    if (event.kind !== 5 && event.kind !== 9_005) continue;
    for (const tag of event.tags) {
      if (tag[0] === "e" && typeof tag[1] === "string") deleted.add(tag[1]);
    }
  }

  return [...new Map(events.map((event) => [event.id, event])).values()]
    .flatMap((event): NavigationCandidateView[] => {
      if (!MESSAGE_KINDS.has(event.kind) || deleted.has(event.id)) return [];
      const channelId = tagValue(event, "h");
      const channel = channelId ? channelsById.get(channelId) : undefined;
      if (!channel || channel.archived) return [];
      const thread = threadReference(event);
      return [
        {
          id: event.id,
          channelId: channel.id,
          channelName: channel.name,
          channelType: channel.type,
          author: profiles.get(event.pubkey) ?? fallbackProfile(event.pubkey),
          content: event.content,
          createdAt: event.created_at,
          rootId: thread.rootId,
          parentId: thread.parentId,
          highPriority: highPriority(event, viewerPubkey),
          isOwn: event.pubkey === viewerPubkey,
        },
      ];
    })
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
