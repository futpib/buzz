"use client";

import { Inbox, Menu, RefreshCw } from "lucide-react";
import { useState } from "react";

import { useRefreshingView } from "@/client/use-refreshing-view";
import { ViewRefreshError } from "@/ui/ViewRefreshError";

import type {
  ChannelView,
  InboxCategory,
  InboxItemView,
  InboxWorkspaceView,
} from "@/server/types";
import { MessageSurfaceCard } from "@/ui/MessageSurfaceCard";
import { ViewRefreshIndicator } from "@/ui/ViewRefreshIndicator";
import { WorkspaceSidebar } from "@/ui/WorkspaceSidebar";

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
  const {
    view,
    refreshing: revalidating,
    error: refreshError,
    refresh,
  } = useRefreshingView(initial, "/api/inbox", "Inbox");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

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
      <section
        className={`threads-panel${refreshError ? " view-panel-error" : ""}`}
      >
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
            <button
              aria-label="Refresh inbox"
              title="Refresh inbox"
              disabled={revalidating}
              onClick={refresh}
              type="button"
            >
              <RefreshCw aria-hidden="true" size={17} />
            </button>
          </div>
        </header>
        <ViewRefreshError
          error={refreshError}
          active={revalidating}
          retry={refresh}
        />
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
