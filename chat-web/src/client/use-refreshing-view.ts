"use client";

import { useEffect, useRef, useState } from "react";
import { fetchView } from "@/client/fetch-view";
import { startViewRefresh } from "@/client/view-refresh";

type ProjectedView = {
  generatedAt: number;
  cacheState: string;
  identity: { pubkey: string };
};

export function useRefreshingView<T extends ProjectedView>(
  initial: T,
  path: string,
  label: string,
  options: { liveUrl?: string; timeoutMs?: number } = {},
) {
  const { liveUrl, timeoutMs = 30_000 } = options;
  const [view, setView] = useState(initial);
  const [refreshing, setRefreshing] = useState(initial.cacheState === "stale");
  const [error, setError] = useState<string | null>(null);
  const [liveRefreshing, setLiveRefreshing] = useState(Boolean(liveUrl));
  const [liveError, setLiveError] = useState<string | null>(null);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    setView(initial);
    setError(null);
    let disposed = false;
    let source: EventSource | null = null;
    const accept = (next: T) =>
      setView((current) =>
        next.generatedAt >= current.generatedAt ? next : current,
      );
    const loop = startViewRefresh({
      label,
      timeoutMs,
      interval: liveUrl ? 60_000 : 15_000,
      delay: liveUrl
        ? 60_000
        : initial.cacheState === "stale"
          ? 0
          : Math.max(0, 15_000 - (Date.now() - initial.generatedAt)),
      onState: (busy, failure) => {
        setRefreshing(busy);
        setError(failure);
      },
      load: async (signal) => {
        accept(
          await fetchView<T>(
            `${path}?fresh=1`,
            initial.identity.pubkey,
            signal,
          ),
        );
        if (liveUrl && source?.readyState === EventSource.CLOSED) connect();
      },
    });
    const connect = () => {
      source?.close();
      if (disposed || !liveUrl) return;
      setLiveRefreshing(true);
      source = new EventSource(liveUrl);
      source.addEventListener("snapshot", (event) => {
        if (disposed) return;
        accept(JSON.parse((event as MessageEvent<string>).data) as T);
        setLiveRefreshing(false);
        setLiveError(null);
      });
      source.addEventListener("status", (event) => {
        if (disposed) return;
        const status = JSON.parse((event as MessageEvent<string>).data) as {
          state: string;
          message?: string;
        };
        setLiveRefreshing(
          status.state === "connecting" || status.state === "refreshing",
        );
        if (status.state === "degraded")
          setLiveError(status.message ?? "Live updates interrupted");
        if (status.state === "live") setLiveError(null);
      });
      source.onerror = () => {
        if (disposed) return;
        setLiveRefreshing(false);
        setLiveError("Live connection interrupted");
        // The scheduled fallback retries closed streams with bounded cadence.
        // Retrying immediately here can spin when SSE fails but HTTP succeeds.
      };
    };
    refresh.current = loop.refresh;
    setRefreshing(initial.cacheState === "stale" && !liveUrl);
    if (liveUrl) connect();
    return () => {
      disposed = true;
      loop.dispose();
      source?.close();
    };
  }, [initial, path, label, liveUrl, timeoutMs]);
  return {
    view,
    refreshing: refreshing || liveRefreshing,
    error: error ?? liveError,
    refresh: () => refresh.current(),
  };
}
