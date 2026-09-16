"use client";

import { Menu, MessageSquareText, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import type { ThreadsWorkspaceView } from "@/server/types";
import { Avatar } from "@/ui/Avatar";
import { SearchDialog } from "@/ui/SearchDialog";
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

export function ThreadsShell({ initial }: { initial: ThreadsWorkspaceView }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  return (
    <main
      className={`workspace workspace-threads${mobileNavOpen ? " mobile-nav-open" : ""}`}
    >
      <button
        aria-label="Dismiss channel navigation"
        className="mobile-nav-backdrop"
        onClick={() => setMobileNavOpen(false)}
        type="button"
      />
      <WorkspaceSidebar
        activePage="threads"
        channels={initial.channels}
        close={() => setMobileNavOpen(false)}
        identity={initial.identity}
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
            <span className="thread-total">{initial.threads.length} total</span>
            <button
              aria-controls="workspace-search"
              aria-expanded={searchOpen}
              aria-label="Search"
              onClick={() => setSearchOpen(true)}
              type="button"
            >
              <Search aria-hidden="true" size={18} />
            </button>
          </div>
        </header>
        <nav className="threads-list" aria-label="All threads">
          {initial.threads.length === 0 ? (
            <p className="empty-timeline">No threads yet.</p>
          ) : (
            initial.threads.map(({ activityAt, channel, root }) => (
              <Link
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
                      {relativeTime(activityAt, initial.generatedAt)}
                    </time>
                  </div>
                  <p>{root.content || "Attachment"}</p>
                  <span className="thread-index-replies">
                    {root.replyCount}{" "}
                    {root.replyCount === 1 ? "reply" : "replies"}
                  </span>
                </div>
              </Link>
            ))
          )}
        </nav>
      </section>
      {searchOpen ? <SearchDialog close={() => setSearchOpen(false)} /> : null}
    </main>
  );
}
