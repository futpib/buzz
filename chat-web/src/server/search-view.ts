import { fallbackProfile } from "@/server/projector";
import { eventThreadTarget } from "@/server/event-navigation";
import type {
  ChannelView,
  NostrEvent,
  ProfileView,
  SearchResultView,
} from "@/server/types";

export const MAX_SEARCH_QUERY_LENGTH = 256;

export function normalizeSearchQuery(value: string): string {
  const query = value.trim();
  if (query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new Error(
      `Search query must be ${MAX_SEARCH_QUERY_LENGTH} characters or fewer`,
    );
  }
  return query;
}

function tagValues(event: NostrEvent, key: string): string[] {
  return event.tags
    .filter((tag) => tag[0] === key && typeof tag[1] === "string")
    .map((tag) => tag[1]);
}

function tagValue(event: NostrEvent, key: string): string | null {
  return tagValues(event, key)[0] ?? null;
}

export function projectSearchResults(
  events: NostrEvent[],
  channels: ChannelView[],
  profiles: Map<string, ProfileView>,
  viewerPubkey: string,
): SearchResultView[] {
  const channelsById = new Map(
    channels.map((channel) => [channel.id, channel]),
  );
  const seen = new Set<string>();
  const results: SearchResultView[] = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const channelId = tagValue(event, "h");
    if (!channelId) continue;
    const channel = channelsById.get(channelId);
    if (!channel) continue;
    results.push({
      id: event.id,
      channelId,
      channelName: channel.name,
      threadId: eventThreadTarget(event),
      author: profiles.get(event.pubkey) ?? fallbackProfile(event.pubkey),
      content: event.content,
      createdAt: event.created_at,
      isOwn: event.pubkey === viewerPubkey,
    });
  }
  return results;
}
