"use client";

import { Bell, Bot, Menu } from "lucide-react";
import { useEffect, useState } from "react";

import type { ActivityItemView, ActivityWorkspaceView } from "@/server/types";
import { Avatar } from "@/ui/Avatar";
import { ViewLink } from "@/ui/ViewLink";
import { ViewRefreshIndicator } from "@/ui/ViewRefreshIndicator";
import { WorkspaceSidebar } from "@/ui/WorkspaceSidebar";

const ACTIVITY_CLIENT_REVALIDATE_AFTER_MS = 10_000;

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

function ActivityRow({
  generatedAt,
  item,
}: {
  generatedAt: number;
  item: ActivityItemView;
}) {
  const content = (
    <>
      <Avatar profile={item.author} />
      <span className="thread-index-content">
        <span className="thread-index-meta">
          <strong>{item.author.name}</strong>
          {item.isOwn ? <span>you</span> : null}
          <span>{kindLabel(item)}</span>
          {item.channel ? <span>#{item.channel.name}</span> : null}
          <time dateTime={new Date(item.createdAt * 1_000).toISOString()}>
            {relativeTime(item.createdAt, generatedAt)}
          </time>
        </span>
        <span className="inbox-preview">{item.content || "Attachment"}</span>
        {item.itemCount > 1 ? (
          <span className="thread-index-replies">
            {item.itemCount} updates in this conversation
          </span>
        ) : null}
      </span>
    </>
  );

  if (!item.channel || !item.threadId) {
    return (
      <article
        className="thread-index-row inbox-row-static"
        data-activity-id={item.id}
      >
        {content}
      </article>
    );
  }

  return (
    <ViewLink
      className="thread-index-row"
      data-activity-id={item.id}
      href={`/channels/${item.channel.id}?${new URLSearchParams({
        thread: item.threadId,
        message: item.id,
      })}`}
      scroll={false}
    >
      {content}
    </ViewLink>
  );
}

export function ActivityShell({ initial }: { initial: ActivityWorkspaceView }) {
  const [view, setView] = useState(initial);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [revalidating, setRevalidating] = useState(
    initial.cacheState === "stale",
  );

  useEffect(() => {
    setView(initial);
    const shouldRevalidate =
      initial.cacheState === "stale" ||
      Date.now() - initial.generatedAt >= ACTIVITY_CLIENT_REVALIDATE_AFTER_MS;
    setRevalidating(shouldRevalidate);
    if (!shouldRevalidate) {
      setRevalidating(false);
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    void fetch("/api/activity?fresh=1", {
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
        return (await response.json()) as ActivityWorkspaceView;
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

  useEffect(() => {
    const source = new EventSource("/api/activity/live");
    source.addEventListener("snapshot", (event) => {
      setView(JSON.parse((event as MessageEvent<string>).data));
      setRevalidating(false);
    });
    source.addEventListener("status", (event) => {
      const status = JSON.parse((event as MessageEvent<string>).data) as {
        state?: string;
      };
      setRevalidating(status.state === "refreshing");
    });
    source.onerror = () => setRevalidating(false);
    return () => source.close();
  }, []);

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
        <section className="threads-list" aria-label="Recent activity">
          {view.items.length === 0 ? (
            <div className="empty-timeline">
              <Bot aria-hidden="true" size={20} />
              <span>No recent activity.</span>
            </div>
          ) : (
            view.items.map((item) => (
              <ActivityRow
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
