import {
  eventConversationId,
  eventThreadTarget,
} from "@/server/event-navigation";
import { fallbackProfile } from "@/server/projector";
import type {
  ActivityItemKind,
  ActivityItemView,
  ChannelView,
  NostrEvent,
  ProfileView,
} from "@/server/types";

const KIND_STREAM_MESSAGE = 9;
const KIND_STREAM_MESSAGE_V2 = 40_002;
const KIND_FORUM_POST = 45_001;
const KIND_JOB_REQUEST = 43_001;
const KIND_JOB_PROGRESS = 43_003;
const KIND_JOB_RESULT = 43_004;

function tagValue(event: NostrEvent, key: string): string | null {
  return (
    event.tags.find(
      (tag) => tag[0] === key && typeof tag[1] === "string",
    )?.[1] ?? null
  );
}

function activityKind(kind: number): ActivityItemKind | null {
  switch (kind) {
    case KIND_STREAM_MESSAGE:
    case KIND_STREAM_MESSAGE_V2:
      return "message";
    case KIND_FORUM_POST:
      return "forum";
    case KIND_JOB_REQUEST:
      return "job_request";
    case KIND_JOB_PROGRESS:
      return "job_progress";
    case KIND_JOB_RESULT:
      return "job_result";
    default:
      return null;
  }
}

export function projectActivityItems(
  events: NostrEvent[],
  channels: ChannelView[],
  profiles: Map<string, ProfileView>,
  viewerPubkey: string,
): ActivityItemView[] {
  const channelsById = new Map(
    channels.map((channel) => [channel.id, channel]),
  );
  const groups = new Map<string, NostrEvent[]>();

  for (const event of new Map(
    events.map((candidate) => [candidate.id, candidate]),
  ).values()) {
    if (!activityKind(event.kind)) continue;
    const channelId = tagValue(event, "h");
    if (channelId && !channelsById.has(channelId)) continue;
    const conversationId = eventConversationId(event);
    const groupKey = `${channelId ?? "global"}:${conversationId}`;
    const group = groups.get(groupKey) ?? [];
    group.push(event);
    groups.set(groupKey, group);
  }

  return [...groups.values()]
    .map((group) => {
      const sorted = [...group].sort(
        (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
      );
      const latest = sorted[0];
      const kind = activityKind(latest.kind);
      if (!kind) return null;
      const channelId = tagValue(latest, "h");
      const channel = channelId ? (channelsById.get(channelId) ?? null) : null;
      return {
        id: latest.id,
        conversationId: eventConversationId(latest),
        channel,
        threadId: channel ? eventThreadTarget(latest) : null,
        author: profiles.get(latest.pubkey) ?? fallbackProfile(latest.pubkey),
        content: latest.content,
        createdAt: latest.created_at,
        kind,
        itemCount: sorted.length,
        isOwn: latest.pubkey === viewerPubkey,
      } satisfies ActivityItemView;
    })
    .filter((item): item is ActivityItemView => item !== null)
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}
