"use client";

import { History, LoaderCircle, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  clearRecentSearches,
  loadRecentSearches,
  rememberRecentSearch,
  removeRecentSearch,
} from "@/client/search-history";
import type { ChannelView, SearchResultView, SearchView } from "@/server/types";
import { MessageSurfaceCard } from "@/ui/MessageSurfaceCard";

const searchViewCache = new Map<string, SearchView>();

function resultTimeLabel(timestamp: number): string {
  const date = new Date(timestamp * 1_000);
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year:
      date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

export function SearchResult({
  channels,
  onOpen,
  result,
}: {
  channels: ChannelView[];
  onOpen: () => void;
  result: SearchResultView;
}) {
  const href = `/channels/${result.channelId}?${new URLSearchParams({
    thread: result.threadId,
    message: result.id,
  })}`;
  return (
    <li>
      <MessageSurfaceCard
        articleProps={{
          className: "search-result",
          "data-search-id": result.id,
        }}
        author={result.author}
        channels={channels}
        compact
        content={result.content}
        createdAt={result.createdAt}
        href={href}
        isOwn={result.isOwn}
        labels={[`#${result.channelName}`]}
        onOpen={onOpen}
        openLabel="Open result"
        timeLabel={resultTimeLabel(result.createdAt)}
      />
    </li>
  );
}

export function SearchDialog({
  channels,
  close,
  viewerPubkey,
}: {
  channels: ChannelView[];
  close: () => void;
  viewerPubkey: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResultView[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const lastSuccessfulQuery = useRef("");

  useEffect(() => {
    setRecentSearches(loadRecentSearches(viewerPubkey));
  }, [viewerPubkey]);

  const remember = useCallback(
    (value: string) => {
      setRecentSearches(rememberRecentSearch(viewerPubkey, value));
    },
    [viewerPubkey],
  );

  const closeWithHistory = useCallback(() => {
    const normalized = query.trim();
    if (
      normalized &&
      normalized.toLowerCase() === lastSuccessfulQuery.current.toLowerCase()
    ) {
      remember(normalized);
    }
    close();
  }, [close, query, remember]);

  useEffect(() => {
    input.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeWithHistory();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeWithHistory]);

  useEffect(() => {
    const normalized = query.trim();
    if (!normalized) {
      lastSuccessfulQuery.current = "";
      setResults([]);
      setSearched(false);
      setLoading(false);
      setError(null);
      return;
    }
    const cacheKey = `${viewerPubkey}\u0000${normalized.toLowerCase()}`;
    const cached = searchViewCache.get(cacheKey);
    if (cached) {
      lastSuccessfulQuery.current = normalized;
      setResults(cached.results);
      setSearched(true);
      setLoading(false);
      setError(null);
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/search?${new URLSearchParams({ q: normalized })}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (response.status === 401) {
          window.location.assign(
            `/login?next=${encodeURIComponent(location.pathname + location.search)}`,
          );
          return;
        }
        const body = (await response.json()) as SearchView & { error?: string };
        if (!response.ok) throw new Error(body.error || "Search failed");
        lastSuccessfulQuery.current = normalized;
        searchViewCache.set(cacheKey, body);
        setResults(body.results);
        setSearched(true);
        if (body.cacheState === "stale") {
          const freshResponse = await fetch(
            `/api/search?${new URLSearchParams({ q: normalized, fresh: "1" })}`,
            { cache: "no-store", signal: controller.signal },
          );
          if (freshResponse.ok) {
            const fresh = (await freshResponse.json()) as SearchView;
            searchViewCache.set(cacheKey, fresh);
            setResults(fresh.results);
          }
        }
      } catch (caught) {
        if (controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : "Search failed");
        setResults([]);
        setSearched(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 180);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [query, viewerPubkey]);

  return (
    <div className="search-layer">
      <button
        aria-label="Close search"
        className="search-backdrop"
        onClick={closeWithHistory}
        type="button"
      />
      <section
        aria-labelledby="search-title"
        aria-modal="true"
        className="search-dialog"
        id="workspace-search"
        role="dialog"
      >
        <header className="search-dialog-header">
          <div>
            <Search aria-hidden="true" size={19} />
            <h2 id="search-title">Search messages</h2>
          </div>
          <button
            aria-label="Close search"
            onClick={closeWithHistory}
            type="button"
          >
            <X aria-hidden="true" size={19} />
          </button>
        </header>
        <div className="search-field">
          <Search aria-hidden="true" size={18} />
          <input
            aria-label="Search messages"
            autoComplete="off"
            maxLength={256}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                remember(query);
              }
            }}
            placeholder="Search across your channels"
            ref={input}
            spellCheck={false}
            type="search"
            value={query}
          />
          {loading ? (
            <LoaderCircle
              aria-label={results.length > 0 ? "Updating search" : "Searching"}
              className="spin"
              size={18}
            />
          ) : null}
        </div>
        <div aria-live="polite" className="search-results">
          {!query.trim() ? (
            recentSearches.length > 0 ? (
              <section
                aria-labelledby="recent-searches-title"
                className="recent-searches"
              >
                <header>
                  <h3 id="recent-searches-title">Recent searches</h3>
                  <button
                    onClick={() => {
                      setRecentSearches(clearRecentSearches(viewerPubkey));
                      input.current?.focus();
                    }}
                    type="button"
                  >
                    Clear all
                  </button>
                </header>
                <ul>
                  {recentSearches.map((recent) => (
                    <li key={recent.toLowerCase()}>
                      <button
                        className="recent-search-query"
                        onClick={() => {
                          remember(recent);
                          setQuery(recent);
                          input.current?.focus();
                        }}
                        type="button"
                      >
                        <History aria-hidden="true" size={16} />
                        <span>{recent}</span>
                      </button>
                      <button
                        aria-label={`Remove “${recent}” from recent searches`}
                        className="recent-search-remove"
                        onClick={() => {
                          setRecentSearches(
                            removeRecentSearch(viewerPubkey, recent),
                          );
                          input.current?.focus();
                        }}
                        type="button"
                      >
                        <Trash2 aria-hidden="true" size={15} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : (
              <p>Find messages in every channel you can access.</p>
            )
          ) : null}
          {error ? <p className="search-error">{error}</p> : null}
          {!loading && searched && !error && results.length === 0 ? (
            <p>No messages matched “{query.trim()}”.</p>
          ) : null}
          {results.length > 0 ? (
            <>
              <p className="search-summary">
                {results.length} {results.length === 1 ? "result" : "results"}
              </p>
              <ul>
                {results.map((result) => (
                  <SearchResult
                    channels={channels}
                    key={result.id}
                    onOpen={() => remember(query)}
                    result={result}
                  />
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}
