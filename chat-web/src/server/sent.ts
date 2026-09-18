import "server-only";

import type { AuthSession } from "@/server/auth";
import { loadWorkspaceIndex } from "@/server/data";
import { fallbackProfile, projectProfiles } from "@/server/projector";
import {
  CHANNEL_HISTORY_KINDS,
  loadProjectionAuxClosureForChannels,
} from "@/server/projection-events";
import { projectSentItems } from "@/server/sent-view";
import type { SentWorkspaceView } from "@/server/types";
import { ViewCache } from "@/server/view-cache";

const SENT_LIMIT = 100;
const SENT_STALE_AFTER_MS = 10_000;
type SentWorkspacePayload = Omit<SentWorkspaceView, "cacheState">;

const sentCache = new ViewCache<SentWorkspacePayload>({
  maxEntries: 128,
  staleAfterMs: SENT_STALE_AFTER_MS,
});

function profileFilter(viewerPubkey: string) {
  return { kinds: [0], authors: [viewerPubkey], limit: 1 };
}

async function loadSentWorkspaceFresh(
  session: AuthSession,
): Promise<SentWorkspacePayload> {
  const { channels } = await loadWorkspaceIndex(session);
  const channelIds = channels.map((channel) => channel.id);
  const messageEvents =
    channelIds.length === 0
      ? []
      : await session.relay.query([
          {
            kinds: [...CHANNEL_HISTORY_KINDS],
            authors: [session.pubkey],
            "#h": channelIds,
            limit: SENT_LIMIT,
          },
        ]);
  const [auxiliaryEvents, profileEvents] = await Promise.all([
    loadProjectionAuxClosureForChannels(
      (filters) => session.relay.query(filters),
      channelIds,
      messageEvents.map((event) => event.id),
    ),
    session.relay.query([profileFilter(session.pubkey)]),
  ]);
  const events = [
    ...new Map(
      [...messageEvents, ...auxiliaryEvents].map((event) => [event.id, event]),
    ).values(),
  ];
  const profiles = projectProfiles(profileEvents);

  return {
    identity: profiles.get(session.pubkey) ?? fallbackProfile(session.pubkey),
    channels,
    items: projectSentItems(events, channels, profiles, session.pubkey),
    generatedAt: Date.now(),
  };
}

export async function loadSentWorkspace(
  session: AuthSession,
): Promise<SentWorkspaceView> {
  const result = await sentCache.get(session.cacheScope, () =>
    loadSentWorkspaceFresh(session),
  );
  return { ...result.value, cacheState: result.state };
}

export async function refreshSentWorkspace(
  session: AuthSession,
): Promise<SentWorkspaceView> {
  const result = await sentCache.refresh(session.cacheScope, () =>
    loadSentWorkspaceFresh(session),
  );
  return { ...result.value, cacheState: result.state };
}

export function markSentViewsStale(session: AuthSession): void {
  sentCache.markStale((key) => key === session.cacheScope);
}
