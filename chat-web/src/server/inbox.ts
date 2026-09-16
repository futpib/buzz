import "server-only";

import type { AuthSession } from "@/server/auth";
import { loadWorkspaceIndex } from "@/server/data";
import { projectInboxItems } from "@/server/inbox-view";
import { fallbackProfile, projectProfiles } from "@/server/projector";
import type { InboxWorkspaceView, NostrEvent } from "@/server/types";
import { ViewCache } from "@/server/view-cache";

const INBOX_LIMIT = 100;
const INBOX_STALE_AFTER_MS = 10_000;
type InboxWorkspacePayload = Omit<InboxWorkspaceView, "cacheState">;

const inboxCache = new ViewCache<InboxWorkspacePayload>({
  maxEntries: 128,
  staleAfterMs: INBOX_STALE_AFTER_MS,
});

function profileFilter(events: NostrEvent[], viewerPubkey: string) {
  const authors = [
    ...new Set([viewerPubkey, ...events.map((event) => event.pubkey)]),
  ].slice(0, 500);
  return { kinds: [0], authors, limit: authors.length };
}

async function loadInboxWorkspaceFresh(
  session: AuthSession,
): Promise<InboxWorkspacePayload> {
  const [{ channels }, mentions, needsAction] = await Promise.all([
    loadWorkspaceIndex(session),
    session.relay.query([
      {
        "#p": [session.pubkey],
        feed_types: ["mentions"],
        limit: INBOX_LIMIT,
      },
    ]),
    session.relay.query([
      {
        "#p": [session.pubkey],
        feed_types: ["needs_action"],
        limit: INBOX_LIMIT,
      },
    ]),
  ]);
  const events = [
    ...new Map(
      [...mentions, ...needsAction].map((event) => [event.id, event]),
    ).values(),
  ];
  const profileEvents = await session.relay.query([
    profileFilter(events, session.pubkey),
  ]);
  const profiles = projectProfiles(profileEvents);
  return {
    identity: profiles.get(session.pubkey) ?? fallbackProfile(session.pubkey),
    channels,
    items: projectInboxItems(events, channels, profiles),
    generatedAt: Date.now(),
  };
}

export async function loadInboxWorkspace(
  session: AuthSession,
): Promise<InboxWorkspaceView> {
  const result = await inboxCache.get(session.cacheScope, () =>
    loadInboxWorkspaceFresh(session),
  );
  return { ...result.value, cacheState: result.state };
}

export async function refreshInboxWorkspace(
  session: AuthSession,
): Promise<InboxWorkspaceView> {
  const result = await inboxCache.refresh(session.cacheScope, () =>
    loadInboxWorkspaceFresh(session),
  );
  return { ...result.value, cacheState: result.state };
}

export function markInboxViewsStale(session: AuthSession): void {
  inboxCache.markStale((key) => key === session.cacheScope);
}
