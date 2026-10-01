"use client";

import { Bell, Bot, Menu } from "lucide-react";
import { useState } from "react";

import { useRefreshingView } from "@/client/use-refreshing-view";
import { ViewRefreshError } from "@/ui/ViewRefreshError";

import type {
  ActivityItemView,
  ActivityWorkspaceView,
  ChannelView,
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

function kindLabel(item: ActivityItemView): string {
  switch (item.kind) {
    case "forum":
      return "Forum post";
    case "job_request":
      return "Job requested";
    case "job_progress":
      return "Progress update";
    case "job_result":
      return "Job result";
    case "message":
      return item.itemCount > 1 ? "Conversation update" : "Message";
  }
}

export function ActivityRow({
  channels,
  generatedAt,
  item,
}: {
  channels: ChannelView[];
  generatedAt: number;
  item: ActivityItemView;
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
        "data-activity-id": item.id,
      }}
      author={item.author}
      channels={channels}
      content={item.content}
      createdAt={item.createdAt}
      footer={
        item.itemCount > 1
          ? `${item.itemCount} updates in this conversation`
          : null
      }
      href={href}
      isOwn={item.isOwn}
      labels={[
        kindLabel(item),
        item.channel ? `#${item.channel.name}` : null,
      ].filter((label): label is string => Boolean(label))}
      openLabel="Open activity"
      timeLabel={relativeTime(item.createdAt, generatedAt)}
    />
  );
}

export function ActivityShell({ initial }: { initial: ActivityWorkspaceView }) {
  const {
    view,
    refreshing: revalidating,
    error: refreshError,
    refresh,
  } = useRefreshingView(initial, "/api/activity", "Activity", {
    liveUrl: "/api/activity/live",
  });
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
        activePage="activity"
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
            <Bell aria-hidden="true" size={19} />
            <div>
              <h1>Activity</h1>
              <p>Recent messages and agent work across your channels</p>
            </div>
          </div>
          <div className="header-actions">
            <ViewRefreshIndicator active={revalidating} />
            <span className="thread-total">{view.items.length} updates</span>
          </div>
        </header>
        <ViewRefreshError
          error={refreshError}
          active={revalidating}
          retry={refresh}
        />
        <section className="threads-list" aria-label="Recent activity">
          {view.items.length === 0 ? (
            <div className="empty-timeline">
              <Bot aria-hidden="true" size={20} />
              <span>No recent activity.</span>
            </div>
          ) : (
            view.items.map((item) => (
              <ActivityRow
                channels={view.channels}
                generatedAt={view.generatedAt}
                item={item}
                key={`${item.channel?.id ?? "global"}:${item.conversationId}`}
              />
            ))
          )}
        </section>
      </section>
    </main>
  );
}
