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
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";

import {
  clearCompletedTyping,
  type ClientTypingEntry,
  pruneTypingEntries,
  registerTypingEntry,
} from "@/client/typing-state";
import type {
  ChannelHistoryPage,
  ChannelSnapshot,
  TypingIndicatorView,
  WorkspaceView,
} from "@/server/types";
import { Composer } from "@/ui/Composer";
import { MessageRow } from "@/ui/MessageRow";
import { SearchDialog } from "@/ui/SearchDialog";
import type { TypingParticipant } from "@/ui/TypingIndicator";
import { ViewRefreshIndicator } from "@/ui/ViewRefreshIndicator";
import { WorkspaceSidebar } from "@/ui/WorkspaceSidebar";
import { ViewLink } from "@/ui/ViewLink";

type LiveState = "connecting" | "live" | "reconnecting";
type ReplyTarget = { id: string; name: string };

export function WorkspaceShell({
  initial,
  targetMessageId = null,
}: {
  initial: WorkspaceView;
  targetMessageId?: string | null;
}) {
  const router = useRouter();
  const [timeline, setTimeline] = useState(initial.timeline);
  const [thread, setThread] = useState(initial.thread);
  const [liveState, setLiveState] = useState<LiveState>("connecting");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const [olderTimeline, setOlderTimeline] = useState(
    initial.timeline.slice(0, 0),
  );
  const [timelineHasMore, setTimelineHasMore] = useState(
    initial.timelineHasMore,
  );
  const [timelineCursor, setTimelineCursor] = useState(initial.timelineCursor);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [revalidating, setRevalidating] = useState(
    initial.cacheState === "stale",
  );
  const [typingEntries, setTypingEntries] = useState<ClientTypingEntry[]>([]);
  const timelineScroller = useRef<HTMLDivElement>(null);
  const timelineEnd = useRef<HTMLDivElement>(null);
  const timelinePinnedToBottom = useRef(true);
  const historyLoaded = useRef(false);
  const historyLoadingRef = useRef(false);
  const restoreTimelineScroll = useRef<{
    height: number;
    top: number;
  } | null>(null);
  const threadScroller = useRef<HTMLDivElement>(null);
  const threadContent = useRef<HTMLDivElement>(null);
  const threadPinnedToBottom = useRef(true);
  const rootId = initial.thread?.rootId ?? null;
  const openThreadId = thread?.rootId ?? null;

  useEffect(() => {
    setTimeline(initial.timeline);
    setOlderTimeline([]);
    setTimelineHasMore(initial.timelineHasMore);
    setTimelineCursor(initial.timelineCursor);
    setHistoryError(null);
    setHistoryLoading(false);
    historyLoaded.current = false;
    historyLoadingRef.current = false;
    timelinePinnedToBottom.current = true;
    setThread(initial.thread);
    setMobileNavOpen(false);
    setSearchOpen(false);
    setReplyTarget(null);
    setRevalidating(initial.cacheState === "stale");
    setTypingEntries([]);
  }, [initial]);

  useEffect(() => {
    const params = new URLSearchParams({ channel: initial.selectedChannel.id });
    if (rootId) params.set("thread", rootId);
    const source = new EventSource(`/api/live?${params}`);
    source.onopen = () => setLiveState("live");
    source.onerror = () => {
      setLiveState("reconnecting");
      setRevalidating(false);
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
      if (!historyLoaded.current) {
        setTimelineHasMore(snapshot.timelineHasMore);
        setTimelineCursor(snapshot.timelineCursor);
      }
      setThread(snapshot.thread);
      setTypingEntries((current) => clearCompletedTyping(current, snapshot));
      setRevalidating(false);
      setLiveState("live");
    });
    source.addEventListener("typing", (event) => {
      const typing = JSON.parse(
        (event as MessageEvent<string>).data,
      ) as TypingIndicatorView;
      setTypingEntries((current) =>
        registerTypingEntry(current, typing, initial.identity.pubkey),
      );
    });
    source.addEventListener("status", (event) => {
      const status = JSON.parse((event as MessageEvent<string>).data) as {
        state?: string;
      };
      if (status.state === "degraded") setRevalidating(false);
    });
    return () => source.close();
  }, [initial.identity.pubkey, initial.selectedChannel.id, rootId]);

  useEffect(() => {
    if (typingEntries.length === 0) return;
    const interval = window.setInterval(
      () => setTypingEntries((current) => pruneTypingEntries(current)),
      1_000,
    );
    return () => window.clearInterval(interval);
  }, [typingEntries.length]);

  useEffect(() => {
    if (timeline.length >= 0 && timelinePinnedToBottom.current) {
      timelineEnd.current?.scrollIntoView({ block: "end" });
    }
  }, [timeline.length]);

  useLayoutEffect(() => {
    if (olderTimeline.length === 0) return;
    const restore = restoreTimelineScroll.current;
    const scroller = timelineScroller.current;
    if (!restore || !scroller) return;
    scroller.scrollTop = restore.top + scroller.scrollHeight - restore.height;
    restoreTimelineScroll.current = null;
  }, [olderTimeline.length]);

  const renderedTimeline = useMemo(
    () =>
      [
        ...new Map(
          [...olderTimeline, ...timeline].map((message) => [
            message.id,
            message,
          ]),
        ).values(),
      ].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    [olderTimeline, timeline],
  );

  const typingParticipants = useMemo(() => {
    const names = new Map<string, string>();
    names.set(initial.identity.pubkey, initial.identity.name);
    for (const message of [
      ...renderedTimeline,
      thread?.root,
      ...(thread?.replies ?? []),
    ]) {
      if (message) names.set(message.author.pubkey, message.author.name);
    }
    const forScope = (threadHeadId: string | null): TypingParticipant[] =>
      typingEntries
        .filter((entry) => entry.threadHeadId === threadHeadId)
        .map((entry) => ({
          pubkey: entry.pubkey,
          name:
            names.get(entry.pubkey) ??
            `${entry.pubkey.slice(0, 8)}…${entry.pubkey.slice(-4)}`,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    return {
      channel: forScope(null),
      thread: thread ? forScope(thread.rootId) : [],
    };
  }, [initial.identity, renderedTimeline, thread, typingEntries]);

  const updateMessage = useCallback(
    (id: string, next: (typeof timeline)[number] | null) => {
      const updateList = (messages: typeof timeline) =>
        next
          ? messages.map((message) => (message.id === id ? next : message))
          : messages.filter((message) => message.id !== id);
      setTimeline(updateList);
      setOlderTimeline(updateList);
      setThread((current) => {
        if (!current) return current;
        return {
          ...current,
          root: current.root?.id === id ? next : current.root,
          replies: updateList(current.replies),
        };
      });
    },
    [],
  );

  const openMessageThread = useCallback(
    (messageId: string) => {
      router.push(
        `/channels/${initial.selectedChannel.id}?${new URLSearchParams({
          thread: messageId,
        })}`,
        { scroll: false },
      );
    },
    [initial.selectedChannel.id, router],
  );

  const loadOlder = useCallback(async () => {
    const cursor = timelineCursor;
    const scroller = timelineScroller.current;
    if (!timelineHasMore || !cursor || !scroller || historyLoadingRef.current) {
      return;
    }
    historyLoadingRef.current = true;
    historyLoaded.current = true;
    setHistoryLoading(true);
    setHistoryError(null);
    restoreTimelineScroll.current = {
      height: scroller.scrollHeight,
      top: scroller.scrollTop,
    };
    try {
      const response = await fetch(
        `/api/channels/${initial.selectedChannel.id}/history?${new URLSearchParams(
          {
            created_at: String(cursor.createdAt),
            id: cursor.id,
          },
        )}`,
        { cache: "no-store" },
      );
      if (response.status === 401) {
        window.location.assign(
          `/login?next=${encodeURIComponent(location.pathname + location.search)}`,
        );
        return;
      }
      const page = (await response.json()) as ChannelHistoryPage & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(page.error || "Older messages could not be loaded");
      }
      setOlderTimeline((current) => [
        ...new Map(
          [...page.messages, ...current].map((message) => [
            message.id,
            message,
          ]),
        ).values(),
      ]);
      const advanced =
        page.nextCursor &&
        (page.nextCursor.createdAt !== cursor.createdAt ||
          page.nextCursor.id !== cursor.id);
      setTimelineHasMore(
        page.hasMore && page.messages.length > 0 && Boolean(advanced),
      );
      setTimelineCursor(advanced ? page.nextCursor : null);
    } catch (caught) {
      restoreTimelineScroll.current = null;
      setHistoryError(
        caught instanceof Error
          ? caught.message
          : "Older messages could not be loaded",
      );
    } finally {
      historyLoadingRef.current = false;
      setHistoryLoading(false);
    }
  }, [initial.selectedChannel.id, timelineCursor, timelineHasMore]);

  useEffect(() => {
    const scroller = threadScroller.current;
    const content = threadContent.current;
    if (!openThreadId || !scroller || !content) return;
    const target = targetMessageId
      ? content.querySelector<HTMLElement>(
          `[data-message-id="${targetMessageId}"]`,
        )
      : null;
    if (target) {
      const frame = requestAnimationFrame(() => {
        target.scrollIntoView({ block: "center" });
        threadPinnedToBottom.current = false;
      });
      return () => cancelAnimationFrame(frame);
    }
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
  }, [openThreadId, targetMessageId]);

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
            <ViewRefreshIndicator active={revalidating} />
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

        <div
          className="timeline"
          onScroll={(event) => {
            const scroller = event.currentTarget;
            timelinePinnedToBottom.current =
              scroller.scrollHeight -
                scroller.clientHeight -
                scroller.scrollTop <=
              40;
            if (scroller.scrollTop <= 80) void loadOlder();
          }}
          ref={timelineScroller}
        >
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
          {timelineHasMore || historyLoading || historyError ? (
            <div className="timeline-history-control" aria-live="polite">
              {historyLoading ? <span>Loading older messages…</span> : null}
              {!historyLoading && historyError ? (
                <button onClick={() => void loadOlder()} type="button">
                  Try loading older messages again
                </button>
              ) : null}
              {!historyLoading && !historyError && timelineHasMore ? (
                <button onClick={() => void loadOlder()} type="button">
                  Load older messages
                </button>
              ) : null}
            </div>
          ) : null}
          {renderedTimeline.length === 0 ? (
            <p className="empty-timeline">
              No messages yet. Start the conversation.
            </p>
          ) : (
            renderedTimeline.map((message) => (
              <MessageRow
                channelId={initial.selectedChannel.id}
                expectedPubkey={initial.identity.pubkey}
                key={message.id}
                message={message}
                onContextReply={() => openMessageThread(message.id)}
                onMessageChange={(next) => updateMessage(message.id, next)}
              />
            ))
          )}
          <div ref={timelineEnd} />
        </div>
        <Composer
          channelId={initial.selectedChannel.id}
          channelName={initial.selectedChannel.name}
          expectedPubkey={initial.identity.pubkey}
          forum={forum}
          typingParticipants={typingParticipants.channel}
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
                  expectedPubkey={initial.identity.pubkey}
                  hideThreadLink
                  highlighted={thread.root.id === targetMessageId}
                  message={thread.root}
                  onMessageChange={(next) =>
                    updateMessage(thread.root?.id ?? thread.rootId, next)
                  }
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
                  expectedPubkey={initial.identity.pubkey}
                  highlighted={message.id === targetMessageId}
                  key={message.id}
                  message={message}
                  onMessageChange={(next) => updateMessage(message.id, next)}
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
            expectedPubkey={initial.identity.pubkey}
            forum={forum}
            parentId={replyTarget?.id ?? thread.rootId}
            replyingTo={replyTarget?.name ?? null}
            cancelReply={() => setReplyTarget(null)}
            onSent={() => setReplyTarget(null)}
            rootId={thread.outerRootId}
            typingParticipants={typingParticipants.thread}
            typingThreadHeadId={thread.rootId}
          />
        </aside>
      ) : (
        <span className="thread-panel-hint" aria-hidden="true">
          <PanelRightClose aria-hidden="true" size={17} />
        </span>
      )}
      {searchOpen ? (
        <SearchDialog
          close={() => setSearchOpen(false)}
          viewerPubkey={initial.identity.pubkey}
        />
      ) : null}
    </main>
  );
}
