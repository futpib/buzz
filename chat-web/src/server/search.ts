import "server-only";

import type { AuthSession } from "@/server/auth";
import { loadWorkspaceIndex } from "@/server/data";
import { projectProfiles } from "@/server/projector";
import {
  normalizeSearchQuery,
  projectSearchResults,
} from "@/server/search-view";
import type { SearchView } from "@/server/types";
import { ViewCache } from "@/server/view-cache";

const SEARCH_LIMIT = 40;
const SEARCH_STALE_AFTER_MS = 10_000;
type SearchPayload = Omit<SearchView, "cacheState">;

const searchCache = new ViewCache<SearchPayload>({
  maxEntries: 512,
  staleAfterMs: SEARCH_STALE_AFTER_MS,
});

function searchCacheKey(session: AuthSession, query: string): string {
  return `${session.cacheScope}:${query}`;
}

async function searchWorkspaceFresh(
  session: AuthSession,
  query: string,
): Promise<SearchPayload> {
  const [{ channels }, events] = await Promise.all([
    loadWorkspaceIndex(session),
    session.relay.query([
      {
        kinds: [9, 40002, 45001, 45003],
        search: query,
        limit: SEARCH_LIMIT,
      },
    ]),
  ]);
  const authors = [...new Set(events.map((event) => event.pubkey))].slice(
    0,
    500,
  );
  const profileEvents =
    authors.length > 0
      ? await session.relay.query([
          { kinds: [0], authors, limit: authors.length },
        ])
      : [];
  return {
    query,
    results: projectSearchResults(
      events,
      channels,
      projectProfiles(profileEvents),
      session.pubkey,
    ),
  };
}

export async function searchWorkspace(
  session: AuthSession,
  rawQuery: string,
): Promise<SearchView> {
  const query = normalizeSearchQuery(rawQuery);
  if (!query) return { query, results: [], cacheState: "fresh" };
  const result = await searchCache.get(searchCacheKey(session, query), () =>
    searchWorkspaceFresh(session, query),
  );
  return { ...result.value, cacheState: result.state };
}

export async function refreshSearchWorkspace(
  session: AuthSession,
  rawQuery: string,
): Promise<SearchView> {
  const query = normalizeSearchQuery(rawQuery);
  if (!query) return { query, results: [], cacheState: "fresh" };
  const result = await searchCache.refresh(searchCacheKey(session, query), () =>
    searchWorkspaceFresh(session, query),
  );
  return { ...result.value, cacheState: result.state };
}

export function markSearchViewsStale(session: AuthSession): void {
  const prefix = `${session.cacheScope}:`;
  searchCache.markStale((key) => key.startsWith(prefix));
}
