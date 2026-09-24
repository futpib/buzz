import "server-only";

import { projectActivityItems } from "@/server/activity-view";
import type { AuthSession } from "@/server/auth";
import { loadWorkspaceIndex } from "@/server/data";
import { fallbackProfile, projectProfiles } from "@/server/projector";
import type { ActivityWorkspaceView, NostrEvent } from "@/server/types";
import { ViewCache } from "@/server/view-cache";

const ACTIVITY_LIMIT = 100;
const ACTIVITY_STALE_AFTER_MS = 10_000;
const CHANNEL_ACTIVITY_KINDS = [9, 40_002, 45_001];
const JOB_ACTIVITY_KINDS = [43_001, 43_003, 43_004];
type ActivityWorkspacePayload = Omit<ActivityWorkspaceView, "cacheState">;

const activityCache = new ViewCache<ActivityWorkspacePayload>({
  maxEntries: 128,
  staleAfterMs: ACTIVITY_STALE_AFTER_MS,
});

function profileFilter(events: NostrEvent[], viewerPubkey: string) {
  const authors = [
    ...new Set([viewerPubkey, ...events.map((event) => event.pubkey)]),
  ].slice(0, 500);
  return { kinds: [0], authors, limit: authors.length };
}

async function loadActivityWorkspaceFresh(
  session: AuthSession,
): Promise<ActivityWorkspacePayload> {
  const { channels } = await loadWorkspaceIndex(session);
  const channelIds = channels.map((channel) => channel.id);
  const queriedEvents = await session.relay.query([
    ...(channelIds.length > 0
      ? [
          {
            kinds: CHANNEL_ACTIVITY_KINDS,
            "#h": channelIds,
            limit: ACTIVITY_LIMIT,
          },
        ]
      : []),
    { kinds: JOB_ACTIVITY_KINDS, limit: ACTIVITY_LIMIT },
  ]);
  const events = [
    ...new Map(queriedEvents.map((event) => [event.id, event])).values(),
  ]
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
    .slice(0, ACTIVITY_LIMIT);
  const profileEvents = await session.relay.query([
    profileFilter(events, session.pubkey),
  ]);
  const profiles = projectProfiles(profileEvents);
  return {
    identity: profiles.get(session.pubkey) ?? fallbackProfile(session.pubkey),
    channels,
    items: projectActivityItems(events, channels, profiles, session.pubkey),
    generatedAt: Date.now(),
  };
}

export async function loadActivityWorkspace(
  session: AuthSession,
): Promise<ActivityWorkspaceView> {
  const result = await activityCache.get(session.cacheScope, () =>
    loadActivityWorkspaceFresh(session),
  );
  return { ...result.value, cacheState: result.state };
}

export async function refreshActivityWorkspace(
  session: AuthSession,
): Promise<ActivityWorkspaceView> {
  const result = await activityCache.refresh(session.cacheScope, () =>
    loadActivityWorkspaceFresh(session),
  );
  return { ...result.value, cacheState: result.state };
}

export function markActivityViewsStale(session: AuthSession): void {
  activityCache.markStale((key) => key === session.cacheScope);
}
