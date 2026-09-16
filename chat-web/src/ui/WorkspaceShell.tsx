"use client";

import {
  Hash,
  LockKeyhole,
  Menu,
  MessageSquareText,
  PanelRightClose,
  Search,
  Users,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ChannelSnapshot, WorkspaceView } from "@/server/types";
import { Composer } from "@/ui/Composer";
import { MessageRow } from "@/ui/MessageRow";
import { SearchDialog } from "@/ui/SearchDialog";
import { WorkspaceSidebar } from "@/ui/WorkspaceSidebar";
import { ViewLink } from "@/ui/ViewLink";

type LiveState = "connecting" | "live" | "reconnecting";
type ReplyTarget = { id: string; name: string };

export function WorkspaceShell({ initial }: { initial: WorkspaceView }) {
  const [timeline, setTimeline] = useState(initial.timeline);
  const [thread, setThread] = useState(initial.thread);
  const [liveState, setLiveState] = useState<LiveState>("connecting");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const timelineEnd = useRef<HTMLDivElement>(null);
  const threadScroller = useRef<HTMLDivElement>(null);
  const threadContent = useRef<HTMLDivElement>(null);
  const threadPinnedToBottom = useRef(true);
  const rootId = initial.thread?.rootId ?? null;
  const openThreadId = thread?.rootId ?? null;

  useEffect(() => {
    setTimeline(initial.timeline);
    setThread(initial.thread);
    setMobileNavOpen(false);
    setSearchOpen(false);
    setReplyTarget(null);
  }, [initial]);

  useEffect(() => {
    const params = new URLSearchParams({ channel: initial.selectedChannel.id });
    if (rootId) params.set("thread", rootId);
    const source = new EventSource(`/api/live?${params}`);
    source.onopen = () => setLiveState("live");
    source.onerror = () => {
      setLiveState("reconnecting");
      void fetch("/api/auth/status", { cache: "no-store" })
        .then((response) => {
          if (response.status === 401) {
            window.location.assign(
              `/login?next=${encodeURIComponent(location.pathname + location.search)}`,
            );
          }
        })
        .catch(() => undefined);
    };
    source.addEventListener("snapshot", (event) => {
      const snapshot = JSON.parse(
        (event as MessageEvent<string>).data,
      ) as ChannelSnapshot;
      setTimeline(snapshot.timeline);
      setThread(snapshot.thread);
      setLiveState("live");
    });
    return () => source.close();
  }, [initial.selectedChannel.id, rootId]);

  useEffect(() => {
    if (timeline.length >= 0) {
      timelineEnd.current?.scrollIntoView({ block: "end" });
    }
  }, [timeline.length]);

  useEffect(() => {
    const scroller = threadScroller.current;
    const content = threadContent.current;
    if (!openThreadId || !scroller || !content) return;
    const scrollToLatest = () => {
      scroller.scrollTop = scroller.scrollHeight;
      threadPinnedToBottom.current = true;
    };
    const frame = requestAnimationFrame(scrollToLatest);
    const keepLatestVisible = () => {
      if (threadPinnedToBottom.current) scrollToLatest();
    };
    const contentObserver = new ResizeObserver(keepLatestVisible);
    const scrollerObserver = new ResizeObserver(keepLatestVisible);
    contentObserver.observe(content);
    scrollerObserver.observe(scroller);
    return () => {
      cancelAnimationFrame(frame);
      contentObserver.disconnect();
      scrollerObserver.disconnect();
    };
  }, [openThreadId]);

  const forum = initial.selectedChannel.type === "forum";
  const threadAuthors = new Map(
    [thread?.root, ...(thread?.replies ?? [])]
      .filter((message) => message !== null && message !== undefined)
      .map((message) => [message.id, message.author.name]),
  );
  const liveLabel =
    liveState === "live"
      ? "Live"
      : liveState === "connecting"
        ? "Connecting"
        : "Reconnecting";

  return (
    <main
      className={`${thread ? "workspace workspace-thread-open" : "workspace"}${mobileNavOpen ? " mobile-nav-open" : ""}`}
      data-cache-state={initial.cacheState}
    >
      <button
        aria-label="Dismiss channel navigation"
        className="mobile-nav-backdrop"
        onClick={() => setMobileNavOpen(false)}
        type="button"
      />
      <WorkspaceSidebar
        activePage="channel"
        channels={initial.channels}
        close={() => setMobileNavOpen(false)}
        identity={initial.identity}
        selectedId={initial.selectedChannel.id}
      />

      <section className="channel-panel">
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
            {initial.selectedChannel.visibility === "private" ? (
              <LockKeyhole aria-hidden="true" size={17} />
            ) : (
              <Hash aria-hidden="true" size={19} />
            )}
            <div>
              <h1>{initial.selectedChannel.name}</h1>
              {initial.selectedChannel.description ? (
                <p>{initial.selectedChannel.description}</p>
              ) : null}
            </div>
          </div>
          <div className="header-actions">
            <span className={`live-status live-${liveState}`}>
              <span /> {liveLabel}
            </span>
            <button
              aria-label="Channel members"
              disabled
              title="Channel members are not available yet"
              type="button"
            >
              <Users aria-hidden="true" size={18} />
            </button>
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

        <div className="timeline">
          <div className="channel-intro">
            <div className="intro-icon">
              {forum ? <MessageSquareText size={25} /> : <Hash size={27} />}
            </div>
            <h2>{initial.selectedChannel.name}</h2>
            <p>
              {initial.selectedChannel.description ||
                `This is the start of #${initial.selectedChannel.name}.`}
            </p>
          </div>
          {timeline.length === 0 ? (
            <p className="empty-timeline">
              No messages yet. Start the conversation.
            </p>
          ) : (
            timeline.map((message) => (
              <MessageRow
                channelId={initial.selectedChannel.id}
                key={message.id}
                message={message}
              />
            ))
          )}
          <div ref={timelineEnd} />
        </div>
        <Composer
          channelId={initial.selectedChannel.id}
          channelName={initial.selectedChannel.name}
          forum={forum}
        />
      </section>

      {thread ? (
        <aside className="thread-panel">
          <header className="thread-header">
            <div>
              <h2>Thread</h2>
              <span>#{initial.selectedChannel.name}</span>
            </div>
            <ViewLink
              aria-label="Close thread"
              className="icon-link"
              href={`/channels/${initial.selectedChannel.id}`}
              prefetchMode="eager"
              scroll={false}
            >
              <X aria-hidden="true" size={19} />
            </ViewLink>
          </header>
          <div
            className="thread-messages"
            onScroll={(event) => {
              const scroller = event.currentTarget;
              threadPinnedToBottom.current =
                scroller.scrollHeight -
                  scroller.clientHeight -
                  scroller.scrollTop <=
                24;
            }}
            ref={threadScroller}
          >
            <div className="thread-messages-content" ref={threadContent}>
              {thread.root ? (
                <MessageRow
                  channelId={initial.selectedChannel.id}
                  hideThreadLink
                  message={thread.root}
                  onReply={() =>
                    setReplyTarget({
                      id: thread.root?.id ?? thread.rootId,
                      name: thread.root?.author.name ?? "thread",
                    })
                  }
                />
              ) : (
                <p className="thread-unavailable">
                  This message is no longer available.
                </p>
              )}
              <div className="reply-divider">
                <span>
                  {thread.replies.length}{" "}
                  {thread.replies.length === 1 ? "reply" : "replies"}
                </span>
                <i />
              </div>
              {thread.replies.map((message) => (
                <MessageRow
                  channelId={initial.selectedChannel.id}
                  compact
                  key={message.id}
                  message={message}
                  onReply={() =>
                    setReplyTarget({
                      id: message.id,
                      name: message.author.name,
                    })
                  }
                  replyingTo={
                    message.parentId && message.parentId !== thread.rootId
                      ? (threadAuthors.get(message.parentId) ??
                        "a previous reply")
                      : null
                  }
                />
              ))}
            </div>
          </div>
          <Composer
            channelId={initial.selectedChannel.id}
            channelName={initial.selectedChannel.name}
            forum={forum}
            parentId={replyTarget?.id ?? thread.rootId}
            replyingTo={replyTarget?.name ?? null}
            cancelReply={() => setReplyTarget(null)}
            onSent={() => setReplyTarget(null)}
            rootId={thread.outerRootId}
          />
        </aside>
      ) : (
        <span className="thread-panel-hint" aria-hidden="true">
          <PanelRightClose aria-hidden="true" size={17} />
        </span>
      )}
      {searchOpen ? <SearchDialog close={() => setSearchOpen(false)} /> : null}
    </main>
  );
}
