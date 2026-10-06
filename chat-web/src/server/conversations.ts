import type { AuthSession } from "@/server/auth";
import {
  fallbackProfile,
  projectChannels,
  projectProfiles,
} from "@/server/projector";
import type { NostrEvent } from "@/server/types";
import type { RelayFilter } from "@/server/relay";
import { sharedViewCache } from "@/server/view-cache";
import {
  CHANNEL_ID,
  PERSON_KEY,
  type ConversationDetails,
  type ConversationDirectory,
} from "@/shared/conversations";

const value = (event: NostrEvent | undefined, key: string) =>
  event?.tags.find((tag) => tag[0] === key)?.[1] ?? "";
const latest = (events: NostrEvent[], kind: number) =>
  events
    .filter((e) => e.kind === kind)
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];

export async function queryDirectoryPages(
  session: Pick<AuthSession, "relay">,
  filter: RelayFilter,
): Promise<NostrEvent[]> {
  const events = new Map<string, NostrEvent>();
  let cursor: NostrEvent | undefined;
  for (let page = 0; page < 100; page++) {
    const batch = await session.relay.query([
      {
        ...filter,
        limit: 500,
        ...(cursor ? { until: cursor.created_at, before_id: cursor.id } : {}),
      },
    ]);
    for (const event of batch) events.set(event.id, event);
    if (batch.length < 500) return [...events.values()];
    const tail = batch.at(-1);
    if (!tail || tail.id === cursor?.id)
      throw new Error("Directory pagination stalled; retry later");
    cursor = tail;
  }
  throw new Error("Directory is too large to load; please try again later");
}

async function loadDirectoryFresh(
  session: AuthSession,
): Promise<Omit<ConversationDirectory, "cacheState">> {
  const [metadata, rosters, profiles] = await Promise.all([
    queryDirectoryPages(session, { kinds: [39000] }),
    queryDirectoryPages(session, { kinds: [39002], "#p": [session.pubkey] }),
    queryDirectoryPages(session, { kinds: [0] }),
  ]);
  const joined = new Set(
    projectChannels([...metadata, ...rosters], session.pubkey).map((c) => c.id),
  );
  // A synthetic roster is used only to reuse the metadata projector, never as authorization.
  const all = projectChannels(
    [
      ...metadata,
      ...metadata.map((e) => ({
        ...e,
        kind: 39002,
        tags: [
          ["d", value(e, "d")],
          ["p", session.pubkey],
        ],
      })),
    ],
    session.pubkey,
  );
  return {
    channels: all
      .filter(
        (c) =>
          joined.has(c.id) ||
          (c.type !== "dm" && c.visibility !== "private" && !c.archived),
      )
      .map((c) => ({ ...c, joined: joined.has(c.id) })),
    people: [...projectProfiles(profiles).values()]
      .filter((p) => p.pubkey !== session.pubkey)
      .sort((a, b) => a.name.localeCompare(b.name)),
    generatedAt: Date.now(),
  };
}
const directoryCache = sharedViewCache<
  Omit<ConversationDirectory, "cacheState">
>("conversation-directory", { maxEntries: 128, staleAfterMs: 30_000 });
export async function loadConversationDirectory(
  session: AuthSession,
  fresh = false,
): Promise<ConversationDirectory> {
  const result = await (fresh
    ? directoryCache.refresh(session.cacheScope, () =>
        loadDirectoryFresh(session),
      )
    : directoryCache.get(session.cacheScope, () =>
        loadDirectoryFresh(session),
      ));
  return { ...result.value, cacheState: result.state };
}
export function invalidateConversationDirectory(session: AuthSession) {
  directoryCache.deleteWhere((key) => key === session.cacheScope);
}
export async function readChannelState(
  session: Pick<AuthSession, "relay">,
  channelId: string,
) {
  if (!CHANNEL_ID.test(channelId)) throw new Error("Invalid channel");
  const events = await session.relay.query([
    { kinds: [39000, 39002], "#d": [channelId], limit: 2 },
  ]);
  return { metadata: latest(events, 39000), roster: latest(events, 39002) };
}
export async function loadConversationDetails(
  session: AuthSession,
  channelId: string,
): Promise<ConversationDetails> {
  const { metadata, roster } = await readChannelState(session, channelId);
  const channel = projectChannels(
    [metadata, roster].filter(Boolean) as NostrEvent[],
    session.pubkey,
  )[0];
  if (!channel) throw new Error("Channel membership is required");
  const roles = new Map(
    (roster?.tags ?? [])
      .filter((t) => t[0] === "p" && PERSON_KEY.test(t[1] ?? ""))
      .map((t) => [t[1], t[3] || "member"]),
  );
  const keys = [...roles.keys()],
    events: NostrEvent[] = [];
  for (let i = 0; i < keys.length; i += 200)
    events.push(
      ...(await session.relay.query([
        { kinds: [0], authors: keys.slice(i, i + 200), limit: 200 },
      ])),
    );
  const profiles = projectProfiles(events);
  const ownRole = roles.get(session.pubkey);
  return {
    channel,
    about: value(metadata, "about"),
    topic: value(metadata, "topic"),
    purpose: value(metadata, "purpose"),
    ttl: value(metadata, "ttl"),
    members: keys.map((key) => ({
      ...(profiles.get(key) ?? fallbackProfile(key)),
      role: roles.get(key) ?? "member",
    })),
    canManage:
      channel.type !== "dm" && (ownRole === "owner" || ownRole === "admin"),
    canLeave:
      channel.type !== "dm" &&
      !(
        ownRole === "owner" &&
        [...roles.values()].filter((r) => r === "owner").length === 1
      ),
  };
}
