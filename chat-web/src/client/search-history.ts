"use client";

export const MAX_RECENT_SEARCHES = 8;

const SEARCH_HISTORY_KEY_PREFIX = "buzz.search-history.v1.";

function browserLocalStorage(): Storage | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

function historyKey(viewerPubkey: string): string | null {
  const identity = viewerPubkey.trim().toLowerCase();
  return identity ? `${SEARCH_HISTORY_KEY_PREFIX}${identity}` : null;
}

function normalizeQuery(query: string): string {
  return query.trim().slice(0, 256);
}

function readHistory(
  viewerPubkey: string,
  storage: Storage | undefined,
): string[] {
  const key = historyKey(viewerPubkey);
  if (!key || !storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const searches: string[] = [];
    for (const value of parsed) {
      if (typeof value !== "string") continue;
      const query = normalizeQuery(value);
      const identity = query.toLowerCase();
      if (!query || seen.has(identity)) continue;
      seen.add(identity);
      searches.push(query);
      if (searches.length === MAX_RECENT_SEARCHES) break;
    }
    return searches;
  } catch {
    return [];
  }
}

function writeHistory(
  viewerPubkey: string,
  searches: string[],
  storage: Storage | undefined,
): void {
  const key = historyKey(viewerPubkey);
  if (!key || !storage) return;
  try {
    if (searches.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(searches));
  } catch {
    // Search must keep working when browser persistence is unavailable.
  }
}

export function loadRecentSearches(
  viewerPubkey: string,
  storage = browserLocalStorage(),
): string[] {
  return readHistory(viewerPubkey, storage);
}

export function rememberRecentSearch(
  viewerPubkey: string,
  value: string,
  storage = browserLocalStorage(),
): string[] {
  const query = normalizeQuery(value);
  if (!query) return readHistory(viewerPubkey, storage);
  const identity = query.toLowerCase();
  const searches = [
    query,
    ...readHistory(viewerPubkey, storage).filter(
      (candidate) => candidate.toLowerCase() !== identity,
    ),
  ].slice(0, MAX_RECENT_SEARCHES);
  writeHistory(viewerPubkey, searches, storage);
  return searches;
}

export function removeRecentSearch(
  viewerPubkey: string,
  value: string,
  storage = browserLocalStorage(),
): string[] {
  const identity = normalizeQuery(value).toLowerCase();
  const searches = readHistory(viewerPubkey, storage).filter(
    (candidate) => candidate.toLowerCase() !== identity,
  );
  writeHistory(viewerPubkey, searches, storage);
  return searches;
}

export function clearRecentSearches(
  viewerPubkey: string,
  storage = browserLocalStorage(),
): string[] {
  writeHistory(viewerPubkey, [], storage);
  return [];
}
