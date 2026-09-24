"use client";

import { Menu, MessageSquareText } from "lucide-react";
import { useEffect, useState } from "react";

import type { ThreadsWorkspaceView } from "@/server/types";
import { Avatar } from "@/ui/Avatar";
import { ViewRefreshIndicator } from "@/ui/ViewRefreshIndicator";
import { WorkspaceSidebar } from "@/ui/WorkspaceSidebar";
import { ViewLink } from "@/ui/ViewLink";

const THREADS_CLIENT_REVALIDATE_AFTER_MS = 10_000;

function relativeTime(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.floor(now / 1_000) - timestamp);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(timestamp * 1_000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year:
      new Date(timestamp * 1_000).getFullYear() === new Date(now).getFullYear()
        ? undefined
        : "numeric",
  });
}

export function ThreadsShell({ initial }: { initial: ThreadsWorkspaceView }) {
  const [view, setView] = useState(initial);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [revalidating, setRevalidating] = useState(
    initial.cacheState === "stale",
  );

  useEffect(() => {
    setView(initial);
    const shouldRevalidate =
      initial.cacheState === "stale" ||
      Date.now() - initial.generatedAt >= THREADS_CLIENT_REVALIDATE_AFTER_MS;
    setRevalidating(shouldRevalidate);
    if (!shouldRevalidate) {
      setRevalidating(false);
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    void fetch("/api/threads?fresh=1", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 401) {
          window.location.assign(
            `/login?next=${encodeURIComponent(location.pathname + location.search)}`,
          );
          return null;
        }
        if (!response.ok) return null;
        return (await response.json()) as ThreadsWorkspaceView;
      })
      .then((fresh) => {
        if (fresh && !controller.signal.aborted) setView(fresh);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!disposed) setRevalidating(false);
      });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [initial]);

  return (
    <main
      className={`workspace workspace-threads${mobileNavOpen ? " mobile-nav-open" : ""}`}
      data-cache-state={view.cacheState}
    >
      <button
        aria-label="Dismiss channel navigation"
        className="mobile-nav-backdrop"
        onClick={() => setMobileNavOpen(false)}
        type="button"
      />
      <WorkspaceSidebar
        activePage="threads"
        channels={view.channels}
        close={() => setMobileNavOpen(false)}
        identity={view.identity}
        selectedId={null}
      />
      <section className="threads-panel">
        <header className="channel-header">
          <button
            aria-controls="channel-navigation"
            aria-expanded={mobileNavOpen}
            aria-label="Open channel navigation"
            className="mobile-menu-button"
            onClick={() => setMobileNavOpen(true)}
            type="button"
          >
            <Menu aria-hidden="true" size={20} />
          </button>
          <div className="channel-title">
            <MessageSquareText aria-hidden="true" size={19} />
            <div>
              <h1>Threads</h1>
              <p>Every conversation in your authorized channels</p>
            </div>
          </div>
          <div className="header-actions">
            <ViewRefreshIndicator active={revalidating} />
            <span className="thread-total">{view.threads.length} total</span>
          </div>
        </header>
        <nav className="threads-list" aria-label="All threads">
          {view.threads.length === 0 ? (
            <p className="empty-timeline">No threads yet.</p>
          ) : (
            view.threads.map(({ activityAt, channel, root }) => (
              <ViewLink
                className="thread-index-row"
                data-channel-id={channel.id}
                data-thread-id={root.id}
                href={`/channels/${channel.id}?thread=${root.id}`}
                key={root.id}
              >
                <Avatar profile={root.author} />
                <div className="thread-index-content">
                  <div className="thread-index-meta">
                    <strong>{root.author.name}</strong>
                    <span>#{channel.name}</span>
                    <time dateTime={new Date(activityAt * 1_000).toISOString()}>
                      {relativeTime(activityAt, view.generatedAt)}
                    </time>
                  </div>
                  <p>{root.content || "Attachment"}</p>
                  <span className="thread-index-replies">
                    {root.replyCount}{" "}
                    {root.replyCount === 1 ? "reply" : "replies"}
                  </span>
                </div>
              </ViewLink>
            ))
          )}
        </nav>
      </section>
    </main>
  );
}
