import "server-only";

import type { AuthSession } from "@/server/auth";
import { loadWorkspaceIndex } from "@/server/data";
import { projectProfiles } from "@/server/projector";
import {
  normalizeSearchQuery,
  projectSearchResults,
} from "@/server/search-view";
import type { SearchView } from "@/server/types";

const SEARCH_LIMIT = 40;

export async function searchWorkspace(
  session: AuthSession,
  rawQuery: string,
): Promise<SearchView> {
  const query = normalizeSearchQuery(rawQuery);
  if (!query) return { query, results: [] };

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
