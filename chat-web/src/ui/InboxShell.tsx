"use client";

import { Inbox, Menu } from "lucide-react";
import { useEffect, useState } from "react";

import type {
  ChannelView,
  InboxCategory,
  InboxItemView,
  InboxWorkspaceView,
} from "@/server/types";
import { MessageSurfaceCard } from "@/ui/MessageSurfaceCard";
import { ViewRefreshIndicator } from "@/ui/ViewRefreshIndicator";
import { WorkspaceSidebar } from "@/ui/WorkspaceSidebar";

const INBOX_CLIENT_REVALIDATE_AFTER_MS = 10_000;

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

function categoryLabel(categories: InboxCategory[]): string {
  if (categories.includes("needs_action")) return "Needs action";
  if (categories.includes("mention")) return "Mention";
  return "Thread";
}

export function InboxRow({
  channels,
  item,
  generatedAt,
}: {
  channels: ChannelView[];
  item: InboxItemView;
  generatedAt: number;
}) {
  const href =
    item.channel && item.threadId
      ? `/channels/${item.channel.id}?${new URLSearchParams({
          thread: item.threadId,
          message: item.id,
        })}`
      : null;
  return (
    <MessageSurfaceCard
      articleProps={{
        className: href ? undefined : "inbox-row-static",
        "data-inbox-id": item.id,
      }}
      author={item.author}
      channels={channels}
      content={item.content}
      createdAt={item.createdAt}
      footer={
        item.itemCount === 1 ? "1 update" : `${item.itemCount} grouped updates`
      }
      href={href}
      labels={[
        categoryLabel(item.categories),
        item.channel ? `#${item.channel.name}` : null,
      ].filter((label): label is string => Boolean(label))}
      openLabel="Open conversation"
      timeLabel={relativeTime(item.createdAt, generatedAt)}
    />
  );
}

export function InboxShell({ initial }: { initial: InboxWorkspaceView }) {
  const [view, setView] = useState(initial);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [revalidating, setRevalidating] = useState(
    initial.cacheState === "stale",
  );

  useEffect(() => {
    setView(initial);
    const shouldRevalidate =
      initial.cacheState === "stale" ||
      Date.now() - initial.generatedAt >= INBOX_CLIENT_REVALIDATE_AFTER_MS;
    setRevalidating(shouldRevalidate);
    if (!shouldRevalidate) {
      setRevalidating(false);
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    void fetch("/api/inbox?fresh=1", {
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
        return (await response.json()) as InboxWorkspaceView;
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
        activePage="inbox"
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
            <Inbox aria-hidden="true" size={19} />
            <div>
              <h1>Inbox</h1>
              <p>Mentions, replies, and items that need your attention</p>
            </div>
          </div>
          <div className="header-actions">
            <ViewRefreshIndicator active={revalidating} />
            <span className="thread-total">
              {view.items.length} conversations
            </span>
          </div>
        </header>
        <section className="threads-list" aria-label="Inbox conversations">
          {view.items.length === 0 ? (
            <p className="empty-timeline">Your inbox is clear.</p>
          ) : (
            view.items.map((item) => (
              <InboxRow
                channels={view.channels}
                generatedAt={view.generatedAt}
                item={item}
                key={item.conversationId}
              />
            ))
          )}
        </section>
      </section>
    </main>
  );
}
