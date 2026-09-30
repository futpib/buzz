"use client";

import { Menu, Send } from "lucide-react";
import { useState } from "react";

import { useRefreshingView } from "@/client/use-refreshing-view";
import { ViewRefreshError } from "@/ui/ViewRefreshError";

import type { SentItemView, SentWorkspaceView } from "@/server/types";
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

export function SentRow({
  channels,
  generatedAt,
  item,
}: {
  channels: SentWorkspaceView["channels"];
  generatedAt: number;
  item: SentItemView;
}) {
  const { message } = item;
  return (
    <MessageSurfaceCard
      articleProps={{
        "data-channel-id": item.channel.id,
        "data-sent-id": item.id,
      }}
      author={message.author}
      channels={channels}
      content={message.content}
      createdAt={message.createdAt}
      editedAt={message.editedAt}
      href={`/channels/${item.channel.id}?${new URLSearchParams({
        thread: item.threadId,
        message: item.id,
      })}`}
      isOwn={message.isOwn}
      labels={[message.parentId ? "Reply" : "Message", `#${item.channel.name}`]}
      reactions={message.reactions}
      timeLabel={relativeTime(message.createdAt, generatedAt)}
    />
  );
}

export function SentShell({ initial }: { initial: SentWorkspaceView }) {
  const {
    view,
    refreshing: revalidating,
    error: refreshError,
    refresh,
  } = useRefreshingView(initial, "/api/sent", "Sent");
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
        activePage="sent"
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
        <ViewRefreshError
          error={refreshError}
          active={revalidating}
          retry={refresh}
        />
        <nav className="threads-list" aria-label="Sent messages">
          {view.items.length === 0 ? (
            <p className="empty-timeline">You haven’t sent any messages yet.</p>
          ) : (
            view.items.map((item) => (
              <SentRow
                channels={view.channels}
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
