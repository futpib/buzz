"use client";

import { Menu, Send } from "lucide-react";
import { useEffect, useState } from "react";

import type { SentItemView, SentWorkspaceView } from "@/server/types";
import { Avatar } from "@/ui/Avatar";
import { ViewLink } from "@/ui/ViewLink";
import { ViewRefreshIndicator } from "@/ui/ViewRefreshIndicator";
import { WorkspaceSidebar } from "@/ui/WorkspaceSidebar";

const SENT_CLIENT_REVALIDATE_AFTER_MS = 10_000;

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

function SentRow({
  generatedAt,
  item,
}: {
  generatedAt: number;
  item: SentItemView;
}) {
  const { message } = item;
  return (
    <ViewLink
      className="thread-index-row"
      data-channel-id={item.channel.id}
      data-sent-id={item.id}
      href={`/channels/${item.channel.id}?${new URLSearchParams({
        thread: item.threadId,
        message: item.id,
      })}`}
      scroll={false}
    >
      <Avatar profile={message.author} />
      <span className="thread-index-content">
        <span className="thread-index-meta">
          <strong>{message.author.name}</strong>
          <span>{message.parentId ? "Reply" : "Message"}</span>
          <span>#{item.channel.name}</span>
          {message.editedAt ? <span>Edited</span> : null}
          <time dateTime={new Date(message.createdAt * 1_000).toISOString()}>
            {relativeTime(message.createdAt, generatedAt)}
          </time>
        </span>
        <span className="inbox-preview">{message.content || "Attachment"}</span>
        {message.reactions.length > 0 ? (
          <span className="sent-reactions">
            {message.reactions.map((reaction) => (
              <span key={reaction.emoji}>
                {reaction.emoji} {reaction.count}
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </ViewLink>
  );
}

export function SentShell({ initial }: { initial: SentWorkspaceView }) {
  const [view, setView] = useState(initial);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [revalidating, setRevalidating] = useState(
    initial.cacheState === "stale",
  );

  useEffect(() => {
    setView(initial);
    const shouldRevalidate =
      initial.cacheState === "stale" ||
      Date.now() - initial.generatedAt >= SENT_CLIENT_REVALIDATE_AFTER_MS;
    setRevalidating(shouldRevalidate);
    if (!shouldRevalidate) {
      setRevalidating(false);
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    void fetch("/api/sent?fresh=1", {
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
        return (await response.json()) as SentWorkspaceView;
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
        activePage="sent"
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
            <Send aria-hidden="true" size={19} />
            <div>
              <h1>Sent</h1>
              <p>Messages you’ve sent across your authorized channels</p>
            </div>
          </div>
          <div className="header-actions">
            <ViewRefreshIndicator active={revalidating} />
            <span className="thread-total">{view.items.length} messages</span>
          </div>
        </header>
        <nav className="threads-list" aria-label="Sent messages">
          {view.items.length === 0 ? (
            <p className="empty-timeline">You haven’t sent any messages yet.</p>
          ) : (
            view.items.map((item) => (
              <SentRow
                generatedAt={view.generatedAt}
                item={item}
                key={item.id}
              />
            ))
          )}
        </nav>
      </section>
    </main>
  );
}
