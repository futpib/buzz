import type { AuthSession } from "@/server/auth";
import { fallbackProfile, projectProfiles } from "@/server/projector";
import { sharedViewCache } from "@/server/view-cache";
import type { NostrEvent } from "@/server/types";
import { PUBLIC_KEY } from "@/shared/mentions";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Load authoritative membership before exposing a roster or publishing mentions. */
export async function loadMemberKeys(
  session: Pick<AuthSession, "pubkey" | "relay">,
  channelId: string,
): Promise<string[]> {
  if (!UUID.test(channelId)) throw new Error("Invalid channel");
  const events = await session.relay.query([
    { kinds: [39002], "#d": [channelId], limit: 1 },
  ]);
  const roster = events
    .filter(
      (event) =>
        event.kind === 39002 &&
        event.tags.some((tag) => tag[0] === "d" && tag[1] === channelId),
    )
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
  const keys = [
    ...new Set(
      (roster?.tags ?? [])
        .filter((tag) => tag[0] === "p" && PUBLIC_KEY.test(tag[1] ?? ""))
        .map((tag) => tag[1]),
    ),
  ];
  if (!keys.includes(session.pubkey))
    throw new Error("Channel membership is required");
  return keys;
}

async function loadFresh(session: AuthSession, channelId: string) {
  const keys = await loadMemberKeys(session, channelId);
  const events: NostrEvent[] = [];
  // Keep each relay filter bounded; a full roster may exceed a single query page.
  for (let offset = 0; offset < keys.length; offset += 200) {
    const authors = keys.slice(offset, offset + 200);
    events.push(
      ...(await session.relay.query([
        { kinds: [0], authors, limit: authors.length },
      ])),
    );
  }
  const profiles = projectProfiles(events);
  return {
    members: keys.map((key) => profiles.get(key) ?? fallbackProfile(key)),
    generatedAt: Date.now(),
  };
}
const cache = sharedViewCache<Awaited<ReturnType<typeof loadFresh>>>(
  "mention-members",
  { maxEntries: 256, staleAfterMs: 30_000 },
);

/** Session-isolated roster projection with stale-while-revalidate reads. */
export async function loadMembers(
  session: AuthSession,
  channelId: string,
  fresh = false,
) {
  const key = `${session.cacheScope}:${channelId}`;
  const result = await (fresh
    ? cache.refresh(key, () => loadFresh(session, channelId))
    : cache.get(key, () => loadFresh(session, channelId)));
  return { ...result.value, cacheState: result.state };
}

/** Recheck recipients against the live roster, never a cached suggestion list. */
export async function validateMentionMembers(
  session: AuthSession,
  event: NostrEvent,
): Promise<void> {
  const recipients = event.tags.filter((tag) => tag[0] === "p");
  if (!recipients.length) return;
  if (recipients.some((tag) => tag.length !== 2 || !PUBLIC_KEY.test(tag[1])))
    throw new Error("Mention public key is invalid");
  const channel = event.tags.find((tag) => tag[0] === "h")?.[1] ?? "";
  const keys = await loadMemberKeys(session, channel);
  if (recipients.some((tag) => !keys.includes(tag[1])))
    throw new Error(
      "A mentioned person is no longer a channel member. Refresh the suggestions and try again.",
    );
}
