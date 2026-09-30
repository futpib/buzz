"use client";

import { Menu, MessageSquareText } from "lucide-react";
import { useState } from "react";

import {
  type ChannelNavigationMeta,
  navigationUnreadForThread,
  useWorkspaceNavigation,
} from "@/client/workspace-navigation";
import { useRefreshingView } from "@/client/use-refreshing-view";
import { ViewRefreshError } from "@/ui/ViewRefreshError";

import type { ThreadSummaryView, ThreadsWorkspaceView } from "@/server/types";
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

export function ThreadSurfaceRow({
  channels,
  generatedAt,
  summary: { activityAt, channel, root },
  unread,
}: {
  channels: ThreadsWorkspaceView["channels"];
  generatedAt: number;
  summary: ThreadSummaryView;
  unread: Pick<ChannelNavigationMeta, "unreadCount" | "highPriorityCount">;
}) {
  return (
    <MessageSurfaceCard
      articleProps={{
        className: unread.unreadCount > 0 ? "message-row-unread" : undefined,
        "data-channel-id": channel.id,
        "data-thread-id": root.id,
      }}
      author={root.author}
      channels={channels}
      content={root.content}
      createdAt={root.createdAt}
      editedAt={root.editedAt}
      footer={
        <>
          {root.replyCount} {root.replyCount === 1 ? "reply" : "replies"}
          {unread.unreadCount > 0 ? (
            <span
              className={
                unread.highPriorityCount > 0
                  ? "thread-unread-badge thread-unread-priority"
                  : "thread-unread-badge"
              }
            >
              {unread.unreadCount > 99 ? "99+" : unread.unreadCount}
            </span>
          ) : null}
        </>
      }
      href={`/channels/${channel.id}?thread=${root.id}`}
      isOwn={root.isOwn}
      labels={[`#${channel.name}`]}
      openLabel="Open thread"
      reactions={root.reactions}
      timeLabel={relativeTime(activityAt, generatedAt)}
    />
  );
}

export function ThreadsShell({ initial }: { initial: ThreadsWorkspaceView }) {
  const {
    view,
    refreshing: revalidating,
    error: refreshError,
    refresh,
  } = useRefreshingView(initial, "/api/threads", "Threads");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const navigation = useWorkspaceNavigation(
    view.identity.pubkey,
    view.channels,
  );
  const orderedThreads = [...view.threads].sort((left, right) => {
    const leftUnread = navigationUnreadForThread(
      navigation.snapshot,
      left.root.id,
    ).unreadCount;
    const rightUnread = navigationUnreadForThread(
      navigation.snapshot,
      right.root.id,
    ).unreadCount;
    return (
      Number(rightUnread > 0) - Number(leftUnread > 0) ||
      right.activityAt - left.activityAt
    );
  });

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
        <ViewRefreshError
          error={refreshError}
          active={revalidating}
          retry={refresh}
        />
        <nav className="threads-list" aria-label="All threads">
          {view.threads.length === 0 ? (
            <p className="empty-timeline">No threads yet.</p>
          ) : (
            orderedThreads.map((summary) => {
              const unread = navigationUnreadForThread(
                navigation.snapshot,
                summary.root.id,
              );
              return (
                <ThreadSurfaceRow
                  channels={view.channels}
                  generatedAt={view.generatedAt}
                  key={summary.root.id}
                  summary={summary}
                  unread={unread}
                />
              );
            })
          )}
        </nav>
      </section>
    </main>
  );
}
