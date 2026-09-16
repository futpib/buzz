import {
  eventConversationId,
  eventHasThreadParent,
  eventThreadTarget,
} from "@/server/event-navigation";
import { fallbackProfile } from "@/server/projector";
import type {
  ChannelView,
  InboxCategory,
  InboxItemView,
  NostrEvent,
  ProfileView,
} from "@/server/types";

const NEEDS_ACTION_KINDS = new Set([40_007, 46_010]);

function tagValue(event: NostrEvent, key: string): string | null {
  return (
    event.tags.find(
      (tag) => tag[0] === key && typeof tag[1] === "string",
    )?.[1] ?? null
  );
}

function categoriesFor(event: NostrEvent): InboxCategory[] {
  const categories: InboxCategory[] = [];
  if (NEEDS_ACTION_KINDS.has(event.kind)) categories.push("needs_action");
  else categories.push("mention");
  if (eventHasThreadParent(event)) categories.push("thread");
  return categories;
}

export function projectInboxItems(
  events: NostrEvent[],
  channels: ChannelView[],
  profiles: Map<string, ProfileView>,
): InboxItemView[] {
  const channelsById = new Map(
    channels.map((channel) => [channel.id, channel]),
  );
  const uniqueEvents = [
    ...new Map(events.map((event) => [event.id, event])).values(),
  ];
  const groups = new Map<string, NostrEvent[]>();
  for (const event of uniqueEvents) {
    const channelId = tagValue(event, "h");
    if (channelId && !channelsById.has(channelId)) continue;
    const conversationId = eventConversationId(event);
    const group = groups.get(conversationId) ?? [];
    group.push(event);
    groups.set(conversationId, group);
  }

  return [...groups]
    .map(([conversationId, group]) => {
      const sorted = [...group].sort(
        (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
      );
      const latest = sorted[0];
      const channelId = tagValue(latest, "h");
      const channel = channelId ? (channelsById.get(channelId) ?? null) : null;
      const categories = [
        ...new Set(sorted.flatMap((event) => categoriesFor(event))),
      ].sort((a, b) => {
        const priority: InboxCategory[] = ["needs_action", "mention", "thread"];
        return priority.indexOf(a) - priority.indexOf(b);
      });
      return {
        id: latest.id,
        conversationId,
        channel,
        threadId: channel ? eventThreadTarget(latest) : null,
        author: profiles.get(latest.pubkey) ?? fallbackProfile(latest.pubkey),
        content: latest.content,
        createdAt: latest.created_at,
        categories,
        itemCount: sorted.length,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}
