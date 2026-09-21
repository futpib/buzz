import type {
  ChannelView,
  MessageView,
  NostrEvent,
  ProfileView,
  ReactionView,
  ThreadSummaryView,
  ThreadView,
} from "@/server/types";

const MESSAGE_KINDS = new Set([9, 40002, 40008, 45001, 45003]);
const DELETION_KINDS = new Set([5, 9005]);

function tagValues(event: NostrEvent, key: string): string[] {
  return event.tags
    .filter((tag) => tag[0] === key && typeof tag[1] === "string")
    .map((tag) => tag[1]);
}

function tagValue(event: NostrEvent, key: string): string | null {
  return tagValues(event, key)[0] ?? null;
}

function hasBareTag(event: NostrEvent, key: string): boolean {
  return event.tags.some((tag) => tag.length === 1 && tag[0] === key);
}

function threadIds(event: NostrEvent): {
  rootId: string;
  parentId: string;
} | null {
  const eventTags = event.tags.filter(
    (tag) => tag[0] === "e" && typeof tag[1] === "string",
  );
  const root = eventTags.find((tag) => tag[3] === "root")?.[1];
  const reply = eventTags.find((tag) => tag[3] === "reply")?.[1];
  if (reply) return { rootId: root ?? reply, parentId: reply };
  // Retain compatibility with older Buzz messages that used a bare e-tag.
  const legacy = eventTags[0]?.[1];
  return legacy ? { rootId: legacy, parentId: legacy } : null;
}

function isNewer(candidate: NostrEvent, current: NostrEvent): boolean {
  return (
    candidate.created_at > current.created_at ||
    (candidate.created_at === current.created_at && candidate.id < current.id)
  );
}

function latestBy(
  events: NostrEvent[],
  kind: number,
  key: (event: NostrEvent) => string | null,
): Map<string, NostrEvent> {
  const latest = new Map<string, NostrEvent>();
  for (const event of events) {
    if (event.kind !== kind) continue;
    const id = key(event);
    if (!id) continue;
    const current = latest.get(id);
    if (!current || isNewer(event, current)) latest.set(id, event);
  }
  return latest;
}

function channelType(raw: string | null): ChannelView["type"] {
  if (raw === "forum" || raw === "dm" || raw === "workflow") return raw;
  return "stream";
}

export function projectChannels(
  events: NostrEvent[],
  viewerPubkey: string,
): ChannelView[] {
  const memberships = latestBy(events, 39002, (event) => tagValue(event, "d"));
  const metadata = latestBy(events, 39000, (event) => tagValue(event, "d"));
  const channels: ChannelView[] = [];

  for (const [id, membership] of memberships) {
    if (!tagValues(membership, "p").includes(viewerPubkey)) continue;
    const event = metadata.get(id);
    if (!event) continue;
    const name = tagValue(event, "name")?.trim();
    if (!name) continue;
    channels.push({
      id,
      name,
      description:
        tagValue(event, "topic") ??
        tagValue(event, "about") ??
        tagValue(event, "purpose") ??
        "",
      type: channelType(tagValue(event, "t")),
      visibility: hasBareTag(event, "private")
        ? "private"
        : hasBareTag(event, "public")
          ? "public"
          : null,
      archived: tagValue(event, "archived") === "true",
    });
  }

  return channels.sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    if (a.type !== b.type) return a.type === "stream" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

function safeProfileContent(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function displayName(pubkey: string, content: Record<string, unknown>): string {
  for (const key of ["display_name", "name", "nip05"] as const) {
    const value = content[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}

function profileInitials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words.at(-1)?.[0] ?? ""}`.toUpperCase();
}

function profileColor(pubkey: string): string {
  let hash = 0;
  for (let index = 0; index < pubkey.length; index += 1) {
    hash = (hash * 31 + pubkey.charCodeAt(index)) >>> 0;
  }
  return `hsl(${hash % 360} 55% 42%)`;
}

export function projectProfiles(
  events: NostrEvent[],
): Map<string, ProfileView> {
  const latest = latestBy(events, 0, (event) => event.pubkey);
  const profiles = new Map<string, ProfileView>();
  for (const [pubkey, event] of latest) {
    const content = safeProfileContent(event.content);
    const name = displayName(pubkey, content);
    const picture = content.picture;
    profiles.set(pubkey, {
      pubkey,
      name,
      picture:
        typeof picture === "string" && /^https?:\/\//.test(picture)
          ? picture
          : null,
      initials: profileInitials(name),
      color: profileColor(pubkey),
    });
  }
  return profiles;
}

export function fallbackProfile(pubkey: string): ProfileView {
  const name = `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
  return {
    pubkey,
    name,
    picture: null,
    initials: profileInitials(name),
    color: profileColor(pubkey),
  };
}

type Summary = {
  replyCount: number;
  lastReplyAt: number | null;
  participantPubkeys: string[];
};

function projectSummaries(events: NostrEvent[]): Map<string, Summary> {
  const summaries = new Map<string, { event: NostrEvent; value: Summary }>();
  for (const event of events) {
    if (event.kind !== 39005) continue;
    const rootId = tagValue(event, "e") ?? tagValue(event, "d");
    if (!rootId) continue;
    try {
      const content = JSON.parse(event.content) as Record<string, unknown>;
      const replyCount = Number(content.reply_count ?? 0);
      const lastReplyAt = content.last_reply_at;
      const participants = content.participants;
      const value = {
        replyCount: Number.isFinite(replyCount) ? Math.max(0, replyCount) : 0,
        lastReplyAt:
          typeof lastReplyAt === "number" && Number.isFinite(lastReplyAt)
            ? lastReplyAt
            : null,
        participantPubkeys: Array.isArray(participants)
          ? participants
              .filter(
                (participant): participant is string =>
                  typeof participant === "string" &&
                  /^[0-9a-f]{64}$/i.test(participant),
              )
              .slice(0, 3)
          : [],
      };
      const current = summaries.get(rootId);
      if (!current || isNewer(event, current.event)) {
        summaries.set(rootId, { event, value });
      }
    } catch {
      // A malformed relay overlay is ignored rather than poisoning the view.
    }
  }
  const projected = new Map(
    [...summaries].map(([id, entry]) => [id, entry.value]),
  );
  const children = new Map<string, NostrEvent[]>();
  for (const event of events) {
    if (!MESSAGE_KINDS.has(event.kind)) continue;
    const parentId = threadIds(event)?.parentId;
    if (!parentId) continue;
    const replies = children.get(parentId) ?? [];
    replies.push(event);
    children.set(parentId, replies);
  }
  for (const [parentId, replies] of children) {
    const newest = [...replies].sort(
      (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
    );
    const participantPubkeys = [
      ...new Set(newest.map((event) => event.pubkey)),
    ].slice(0, 3);
    const derived: Summary = {
      replyCount: replies.length,
      lastReplyAt: newest[0]?.created_at ?? null,
      participantPubkeys,
    };
    const relay = projected.get(parentId);
    if (!relay) {
      projected.set(parentId, derived);
      continue;
    }
    projected.set(parentId, {
      replyCount: Math.max(relay.replyCount, derived.replyCount),
      lastReplyAt: Math.max(relay.lastReplyAt ?? 0, derived.lastReplyAt ?? 0),
      participantPubkeys: [
        ...new Set([
          ...relay.participantPubkeys,
          ...derived.participantPubkeys,
        ]),
      ].slice(0, 3),
    });
  }
  return projected;
}

function deletedIds(events: NostrEvent[]): Set<string> {
  const deleted = new Set<string>();
  for (const event of events) {
    if (!DELETION_KINDS.has(event.kind)) continue;
    for (const target of tagValues(event, "e")) deleted.add(target);
  }
  return deleted;
}

function latestEdits(
  events: NostrEvent[],
  deleted: Set<string>,
): Map<string, NostrEvent> {
  const edits = new Map<string, NostrEvent>();
  for (const event of events) {
    if (event.kind !== 40003 || deleted.has(event.id)) continue;
    const target = tagValues(event, "e").at(-1);
    if (!target) continue;
    const current = edits.get(target);
    if (!current || isNewer(event, current)) edits.set(target, event);
  }
  return edits;
}

function projectReactions(
  events: NostrEvent[],
  deleted: Set<string>,
  viewerPubkey: string,
): Map<string, ReactionView[]> {
  const targets = new Map<string, Map<string, Map<string, string>>>();
  for (const event of events) {
    if (event.kind !== 7 || deleted.has(event.id)) continue;
    const target = tagValues(event, "e").at(-1);
    const emoji = event.content.trim();
    if (!target || !emoji) continue;
    const byEmoji =
      targets.get(target) ?? new Map<string, Map<string, string>>();
    const authors = byEmoji.get(emoji) ?? new Map<string, string>();
    authors.set(event.pubkey, event.id);
    byEmoji.set(emoji, authors);
    targets.set(target, byEmoji);
  }

  return new Map(
    [...targets].map(([target, byEmoji]) => [
      target,
      [...byEmoji]
        .map(([emoji, authors]) => ({
          emoji,
          count: authors.size,
          reactedByMe: authors.has(viewerPubkey),
          ...(authors.get(viewerPubkey)
            ? { ownEventId: authors.get(viewerPubkey) }
            : {}),
        }))
        .sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji)),
    ]),
  );
}

function messageView(
  event: NostrEvent,
  profiles: Map<string, ProfileView>,
  viewerPubkey: string,
  edits: Map<string, NostrEvent>,
  summaries: Map<string, Summary>,
  reactions: Map<string, ReactionView[]>,
): MessageView {
  const edit = edits.get(event.id);
  const usableEdit = edit?.pubkey === event.pubkey ? edit : null;
  const summary = summaries.get(event.id);
  const thread = threadIds(event);
  return {
    id: event.id,
    threadRootId: thread?.rootId ?? null,
    parentId: thread?.parentId ?? null,
    author: profiles.get(event.pubkey) ?? fallbackProfile(event.pubkey),
    content: usableEdit?.content ?? event.content,
    createdAt: event.created_at,
    editedAt: usableEdit?.created_at ?? null,
    isOwn: event.pubkey === viewerPubkey,
    replyCount: summary?.replyCount ?? 0,
    lastReplyAt: summary?.lastReplyAt ?? null,
    replyParticipants:
      summary?.participantPubkeys.map(
        (pubkey) => profiles.get(pubkey) ?? fallbackProfile(pubkey),
      ) ?? [],
    reactions: reactions.get(event.id) ?? [],
  };
}

export function projectTimeline(
  events: NostrEvent[],
  channelId: string,
  profiles: Map<string, ProfileView>,
  viewerPubkey: string,
): MessageView[] {
  return projectMessages(events, channelId, profiles, viewerPubkey).filter(
    (message) => message.threadRootId === null,
  );
}

/**
 * Project every visible message in one channel, including replies, after
 * folding its edit, deletion, summary, and reaction closure.
 */
export function projectMessages(
  events: NostrEvent[],
  channelId: string,
  profiles: Map<string, ProfileView>,
  viewerPubkey: string,
): MessageView[] {
  const deleted = deletedIds(events);
  const edits = latestEdits(events, deleted);
  const summaries = projectSummaries(events);
  const reactions = projectReactions(events, deleted, viewerPubkey);
  return events
    .filter(
      (event) =>
        MESSAGE_KINDS.has(event.kind) &&
        tagValue(event, "h") === channelId &&
        !deleted.has(event.id),
    )
    .map((event) =>
      messageView(event, profiles, viewerPubkey, edits, summaries, reactions),
    )
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function projectThreadIndex(
  events: NostrEvent[],
  channels: ChannelView[],
  profiles: Map<string, ProfileView>,
  viewerPubkey: string,
): ThreadSummaryView[] {
  return channels
    .flatMap((channel) =>
      projectTimeline(events, channel.id, profiles, viewerPubkey).map(
        (root) => ({
          channel,
          root,
          activityAt: root.lastReplyAt ?? root.createdAt,
        }),
      ),
    )
    .sort(
      (a, b) =>
        b.activityAt - a.activityAt || b.root.id.localeCompare(a.root.id),
    );
}

export function projectThread(
  events: NostrEvent[],
  channelId: string,
  rootId: string,
  profiles: Map<string, ProfileView>,
  viewerPubkey: string,
): ThreadView {
  const deleted = deletedIds(events);
  const edits = latestEdits(events, deleted);
  const summaries = projectSummaries(events);
  const reactions = projectReactions(events, deleted, viewerPubkey);
  const rows = events.filter(
    (event) =>
      MESSAGE_KINDS.has(event.kind) &&
      tagValue(event, "h") === channelId &&
      !deleted.has(event.id),
  );
  const rootEvent = rows.find((event) => event.id === rootId) ?? null;
  const root = rootEvent
    ? messageView(
        rootEvent,
        profiles,
        viewerPubkey,
        edits,
        summaries,
        reactions,
      )
    : null;
  const outerRootId = rootEvent
    ? (threadIds(rootEvent)?.rootId ?? rootId)
    : rootId;
  const replies = rows
    .filter(
      (event) => event.id !== rootId && threadIds(event)?.parentId === rootId,
    )
    .map((event) =>
      messageView(event, profiles, viewerPubkey, edits, summaries, reactions),
    )
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return { rootId, outerRootId, root, replies };
}
