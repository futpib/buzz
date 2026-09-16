"use client";

import { LoaderCircle, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { SearchResultView, SearchView } from "@/server/types";
import { Avatar } from "@/ui/Avatar";
import { ViewLink } from "@/ui/ViewLink";

const searchViewCache = new Map<string, SearchView>();

function ResultTime({ timestamp }: { timestamp: number }) {
  const date = new Date(timestamp * 1_000);
  return (
    <time dateTime={date.toISOString()} suppressHydrationWarning>
      {date.toLocaleDateString([], {
        month: "short",
        day: "numeric",
        year:
          date.getFullYear() === new Date().getFullYear()
            ? undefined
            : "numeric",
      })}
    </time>
  );
}

function Result({ result }: { result: SearchResultView }) {
  const href = `/channels/${result.channelId}?${new URLSearchParams({
    thread: result.threadId,
    message: result.id,
  })}`;
  return (
    <li>
      <ViewLink className="search-result" href={href} scroll={false}>
        <Avatar profile={result.author} small />
        <span className="search-result-body">
          <span className="search-result-meta">
            <strong>{result.author.name}</strong>
            {result.isOwn ? <i>you</i> : null}
            <span>#{result.channelName}</span>
            <ResultTime timestamp={result.createdAt} />
          </span>
          <span className="search-result-content">{result.content}</span>
        </span>
      </ViewLink>
    </li>
  );
}

export function SearchDialog({
  close,
  viewerPubkey,
}: {
  close: () => void;
  viewerPubkey: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResultView[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  useEffect(() => {
    const normalized = query.trim();
    if (!normalized) {
      setResults([]);
      setSearched(false);
      setLoading(false);
      setError(null);
      return;
    }
    const cacheKey = `${viewerPubkey}\u0000${normalized.toLowerCase()}`;
    const cached = searchViewCache.get(cacheKey);
    if (cached) {
      setResults(cached.results);
      setSearched(true);
      setLoading(false);
      setError(null);
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      if (!cached) setLoading(true);
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
        onClick={close}
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
          <button aria-label="Close search" onClick={close} type="button">
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
            placeholder="Search across your channels"
            ref={input}
            spellCheck={false}
            type="search"
            value={query}
          />
          {loading ? (
            <LoaderCircle aria-label="Searching" className="spin" size={18} />
          ) : null}
        </div>
        <div aria-live="polite" className="search-results">
          {!query.trim() ? (
            <p>Find messages in every channel you can access.</p>
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
                  <Result key={result.id} result={result} />
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}
