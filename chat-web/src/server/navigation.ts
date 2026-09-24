import "server-only";

import { projectNavigationCandidates } from "@/server/navigation-view";
import type { AuthSession } from "@/server/auth";
import { loadWorkspaceIndex } from "@/server/data";
import { projectProfiles } from "@/server/projector";
import type { NavigationWorkspaceView, NostrEvent } from "@/server/types";
import { ViewCache } from "@/server/view-cache";

export const NAVIGATION_MESSAGE_KINDS = [
  5, 9, 9_005, 40_002, 40_008, 45_001, 45_003,
];
export const NAVIGATION_APP_DATA_KIND = 30_078;
export const NAVIGATION_HORIZON_SECONDS = 7 * 24 * 60 * 60;
// This projection runs on every workspace surface. Keep the cold relay query
// bounded to a recent window that can complete inside the relay request
// timeout; live delivery and encrypted read markers carry it forward from
// there.
const NAVIGATION_EVENT_LIMIT = 500;
const NAVIGATION_APP_DATA_LIMIT = 500;
const NAVIGATION_STALE_AFTER_MS = 5_000;

type NavigationPayload = NavigationWorkspaceView;

const navigationCache = new ViewCache<NavigationPayload>({
  maxEntries: 128,
  staleAfterMs: NAVIGATION_STALE_AFTER_MS,
});

function profileFilter(events: NostrEvent[]) {
  const authors = [...new Set(events.map((event) => event.pubkey))].slice(
    0,
    500,
  );
  return { kinds: [0], authors, limit: Math.max(1, authors.length) };
}

async function loadNavigationFresh(
  session: AuthSession,
): Promise<NavigationPayload> {
  const { channels } = await loadWorkspaceIndex(session);
  const activeChannelIds = channels
    .filter((channel) => !channel.archived)
    .map((channel) => channel.id);
  const filters = [
    ...(activeChannelIds.length > 0
      ? [
          {
            kinds: NAVIGATION_MESSAGE_KINDS,
            "#h": activeChannelIds,
            since: Math.floor(Date.now() / 1_000) - NAVIGATION_HORIZON_SECONDS,
            limit: NAVIGATION_EVENT_LIMIT,
          },
        ]
      : []),
    {
      kinds: [NAVIGATION_APP_DATA_KIND],
      authors: [session.pubkey],
      limit: NAVIGATION_APP_DATA_LIMIT,
    },
  ];
  const events = await session.relay.query(filters);
  const messageEvents = events.filter(
    (event) => event.kind !== NAVIGATION_APP_DATA_KIND,
  );
  const appDataEvents = events
    .filter(
      (event) =>
        event.kind === NAVIGATION_APP_DATA_KIND &&
        event.pubkey === session.pubkey,
    )
    .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));
  const profileEvents =
    messageEvents.length > 0
      ? await session.relay.query([profileFilter(messageEvents)])
      : [];
  return {
    candidates: projectNavigationCandidates(
      messageEvents,
      channels,
      projectProfiles(profileEvents),
      session.pubkey,
    ),
    appDataEvents,
    generatedAt: Date.now(),
  };
}

export async function loadNavigationWorkspace(
  session: AuthSession,
): Promise<NavigationWorkspaceView> {
  return (
    await navigationCache.get(session.cacheScope, () =>
      loadNavigationFresh(session),
    )
  ).value;
}

export async function refreshNavigationWorkspace(
  session: AuthSession,
): Promise<NavigationWorkspaceView> {
  return (
    await navigationCache.refresh(session.cacheScope, () =>
      loadNavigationFresh(session),
    )
  ).value;
}

export async function applyNavigationAppDataEvent(
  session: AuthSession,
  event: NostrEvent,
): Promise<NavigationWorkspaceView> {
  const current = await loadNavigationWorkspace(session);
  const appDataEvents = [
    event,
    ...current.appDataEvents.filter((candidate) => candidate.id !== event.id),
  ]
    .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id))
    .slice(0, NAVIGATION_APP_DATA_LIMIT);
  const next = { ...current, appDataEvents, generatedAt: Date.now() };
  navigationCache.set(session.cacheScope, next);
  return next;
}

export function markNavigationViewsStale(session: AuthSession): void {
  navigationCache.markStale((key) => key === session.cacheScope);
}
