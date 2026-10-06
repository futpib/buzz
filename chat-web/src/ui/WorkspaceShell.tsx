"use client";

import { fetchView } from "@/client/fetch-view";

import {
  Hash,
  LockKeyhole,
  Menu,
  MessageSquareText,
  PanelRightClose,
  Users,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";

import {
  clearCompletedTyping,
  type ClientTypingEntry,
  pruneTypingEntries,
  registerTypingEntry,
} from "@/client/typing-state";
import {
  clampThreadPanelWidth,
  defaultThreadPanelWidth,
  readThreadPanelWidth,
  threadPanelWidthBounds,
  writeThreadPanelWidth,
} from "@/client/thread-panel-size";
import {
  navigationMetaForChannel,
  navigationUnreadForThread,
  useWorkspaceNavigation,
} from "@/client/workspace-navigation";
import type {
  ChannelHistoryPage,
  ChannelSnapshot,
  TypingIndicatorView,
  WorkspaceView,
} from "@/server/types";
import { ConversationDialog } from "@/ui/ConversationDialog";
import { Composer } from "@/ui/Composer";
import { ChannelPinsContext, PinnedMessages } from "@/ui/PinnedMessages";
import { MessageRow } from "@/ui/MessageRow";
import type { TypingParticipant } from "@/ui/TypingIndicator";
import { ViewRefreshIndicator } from "@/ui/ViewRefreshIndicator";
import { WorkspaceSidebar } from "@/ui/WorkspaceSidebar";
import { NavigationProgress, ViewLink } from "@/ui/ViewLink";

type LiveState = "connecting" | "live" | "reconnecting";
type ReplyTarget = { id: string; name: string };
type WorkspaceStyle = CSSProperties & { "--thread-panel-width": string };

export function WorkspaceShell({
  initial,
  targetMessageId = null,
}: {
  initial: WorkspaceView;
  targetMessageId?: string | null;
}) {
  const router = useRouter();
  const [navigationPending, startNavigation] = useTransition();
  const [pins, setPins] = useState(initial.pins);
  const [timeline, setTimeline] = useState(initial.timeline);
  const [thread, setThread] = useState(initial.thread);
  const [liveState, setLiveState] = useState<LiveState>("connecting");
  const [membersOpen, setMembersOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const [preferredThreadPanelWidth, setPreferredThreadPanelWidth] = useState<
    number | null
  >(null);
  const [viewportWidth, setViewportWidth] = useState<number | null>(null);
  const [threadPanelResizing, setThreadPanelResizing] = useState(false);
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
  const [firstUnreadId, setFirstUnreadId] = useState<string | null>(null);
  const [firstThreadUnreadId, setFirstThreadUnreadId] = useState<string | null>(
    null,
  );
  const timelineScroller = useRef<HTMLDivElement>(null);
  const timelineEnd = useRef<HTMLDivElement>(null);
  const timelinePinnedToBottom = useRef(true);
  const historyLoaded = useRef(false);
  const historyLoadingRef = useRef(false);
  const historyAbort = useRef<AbortController | null>(null);
  const restoreTimelineScroll = useRef<{
    height: number;
    top: number;
  } | null>(null);
  const threadScroller = useRef<HTMLDivElement>(null);
  const threadContent = useRef<HTMLDivElement>(null);
  const threadPinnedToBottom = useRef(true);
  const threadPanelWidthRef = useRef<number | null>(null);
  const threadResize = useRef<{
    pointerId: number;
    startWidth: number;
    startX: number;
  } | null>(null);
  const channelScope = `${initial.identity.pubkey}:${initial.selectedChannel.id}`;
  const previousChannelScope = useRef(channelScope);
  const capturedUnreadChannel = useRef<string | null>(null);
  const capturedUnreadThread = useRef<string | null>(null);
  const rootId = initial.thread?.rootId ?? null;
  const openThreadId = thread?.rootId ?? null;
  const navigation = useWorkspaceNavigation(
    initial.identity.pubkey,
    initial.channels,
  );

  useLayoutEffect(() => {
    const width = window.innerWidth;
    const preferred =
      readThreadPanelWidth(window.localStorage) ??
      defaultThreadPanelWidth(width);
    threadPanelWidthRef.current = clampThreadPanelWidth(preferred, width);
    setPreferredThreadPanelWidth(preferred);
    setViewportWidth(width);
  }, []);

  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, []);

  useEffect(() => {
    // Opening another branch must not discard loaded channel history or its
    // scroll anchor. The live snapshot refreshes this retained channel state.
    if (previousChannelScope.current !== channelScope) {
      previousChannelScope.current = channelScope;
      historyAbort.current?.abort();
      restoreTimelineScroll.current = null;
      setPins(initial.pins);
      setTimeline(initial.timeline);
      setOlderTimeline([]);
      setTimelineHasMore(initial.timelineHasMore);
      setTimelineCursor(initial.timelineCursor);
      setHistoryError(null);
      setHistoryLoading(false);
      historyLoaded.current = false;
      historyLoadingRef.current = false;
      timelinePinnedToBottom.current = true;
      setFirstUnreadId(null);
      capturedUnreadChannel.current = null;
    }
    setThread(initial.thread);
    setMobileNavOpen(false);
    setReplyTarget(null);
    setRevalidating(initial.cacheState === "stale");
    setTypingEntries([]);
    setFirstThreadUnreadId(null);
    capturedUnreadThread.current = null;
  }, [initial, channelScope]);

  useEffect(() => {
    if (
      !navigation.snapshot.ready ||
      capturedUnreadChannel.current === initial.selectedChannel.id
    ) {
      return;
    }
    const meta = navigationMetaForChannel(
      navigation.snapshot,
      initial.selectedChannel.id,
    );
    capturedUnreadChannel.current = initial.selectedChannel.id;
    setFirstUnreadId(meta.firstUnreadId);
    navigation.controller.markChannelRead(initial.selectedChannel.id);
  }, [initial.selectedChannel.id, navigation.controller, navigation.snapshot]);

  useEffect(() => {
    if (
      !navigation.snapshot.ready ||
      !openThreadId ||
      capturedUnreadThread.current === openThreadId
    ) {
      return;
    }
    const meta = navigationUnreadForThread(navigation.snapshot, openThreadId);
    capturedUnreadThread.current = openThreadId;
    setFirstThreadUnreadId(meta.firstUnreadId);
    navigation.controller.markThreadRead(openThreadId);
  }, [navigation.controller, navigation.snapshot, openThreadId]);

  useEffect(() => {
    const params = new URLSearchParams({ channel: initial.selectedChannel.id });
    if (rootId) params.set("thread", rootId);
    const abort = new AbortController();
    let source: EventSource;
    let recovering = false;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    let recoveryDelay = 2_000;
    const scheduleRecovery = () => {
      if (abort.signal.aborted || recovering || recoveryTimer) return;
      recoveryTimer = setTimeout(() => {
        recoveryTimer = undefined;
        if (source.readyState !== EventSource.CLOSED) return;
        recovering = true;
        void fetchView(
          "/api/auth/status",
          initial.identity.pubkey,
          AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
        )
          .then(() => {
            if (!abort.signal.aborted) connect();
          })
          .catch(() => undefined)
          .finally(() => {
            recovering = false;
            if (source.readyState === EventSource.CLOSED) scheduleRecovery();
          });
      }, recoveryDelay);
      recoveryDelay = Math.min(30_000, recoveryDelay * 2);
    };
    const connect = () => {
      source?.close();
      source = new EventSource(`/api/live?${params}`);
      source.onopen = () => {
        setLiveState("connecting");
        setRevalidating(true);
      };
      source.onerror = () => {
        setLiveState("reconnecting");
        setRevalidating(false);
        scheduleRecovery();
      };
      source.addEventListener("snapshot", (event) => {
        if (abort.signal.aborted) return;
        recoveryDelay = 2_000;
        const snapshot = JSON.parse(
          (event as MessageEvent<string>).data,
        ) as ChannelSnapshot;
        setPins(snapshot.pins);
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
        if (status.state === "degraded") {
          setRevalidating(false);
          setLiveState("reconnecting");
        } else if (
          status.state === "refreshing" ||
          status.state === "connecting"
        ) {
          setRevalidating(true);
        } else if (status.state === "live") {
          setRevalidating(false);
          setLiveState("live");
        }
      });
    };
    connect();
    return () => {
      abort.abort();
      clearTimeout(recoveryTimer);
      source.close();
    };
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: Restore after each page replacement, including same-size edits.
  useLayoutEffect(() => {
    const restore = restoreTimelineScroll.current;
    const scroller = timelineScroller.current;
    if (!restore || !scroller) return;
    scroller.scrollTop = restore.top + scroller.scrollHeight - restore.height;
    restoreTimelineScroll.current = null;
  }, [olderTimeline]);

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
      startNavigation(() => {
        router.push(
          `/channels/${initial.selectedChannel.id}?${new URLSearchParams({
            thread: messageId,
          })}`,
          { scroll: false },
        );
      });
    },
    [initial.selectedChannel.id, router],
  );

  useEffect(() => () => historyAbort.current?.abort(), []);

  const loadOlder = useCallback(async () => {
    const cursor = timelineCursor;
    const scroller = timelineScroller.current;
    if (!timelineHasMore || !cursor || !scroller || historyLoadingRef.current) {
      return;
    }
    const controller = new AbortController();
    historyAbort.current = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(30_000),
    ]);
    historyLoadingRef.current = true;
    historyLoaded.current = true;
    setHistoryLoading(true);
    setHistoryError(null);
    restoreTimelineScroll.current = {
      height: scroller.scrollHeight,
      top: scroller.scrollTop,
    };
    try {
      const url = `/api/channels/${initial.selectedChannel.id}/history?${new URLSearchParams(
        {
          created_at: String(cursor.createdAt),
          id: cursor.id,
        },
      )}`;
      let page = await fetchView<ChannelHistoryPage>(
        url,
        initial.identity.pubkey,
        signal,
      );
      setOlderTimeline((current) => [
        ...new Map(
          [...page.messages, ...current].map((message) => [
            message.id,
            message,
          ]),
        ).values(),
      ]);
      if (page.cacheState === "stale") {
        const oldIds = new Set(page.messages.map((message) => message.id));
        page = await fetchView<ChannelHistoryPage>(
          `${url}&fresh=1`,
          initial.identity.pubkey,
          signal,
        );
        restoreTimelineScroll.current = {
          height: scroller.scrollHeight,
          top: scroller.scrollTop,
        };
        setOlderTimeline((current) => [
          ...current.filter((message) => !oldIds.has(message.id)),
          ...page.messages,
        ]);
      }
      const advanced =
        page.nextCursor &&
        (page.nextCursor.createdAt !== cursor.createdAt ||
          page.nextCursor.id !== cursor.id);
      setTimelineHasMore(
        page.hasMore && page.messages.length > 0 && Boolean(advanced),
      );
      setTimelineCursor(advanced ? page.nextCursor : null);
    } catch (caught) {
      if (controller.signal.aborted) return;
      restoreTimelineScroll.current = null;
      setHistoryError(
        caught instanceof Error
          ? caught.message
          : "Older messages could not be loaded",
      );
    } finally {
      if (!controller.signal.aborted) {
        historyLoadingRef.current = false;
        setHistoryLoading(false);
      }
    }
  }, [
    initial.selectedChannel.id,
    initial.identity.pubkey,
    timelineCursor,
    timelineHasMore,
  ]);

  const jumpToFirstUnread = useCallback(async () => {
    const targetId = firstThreadUnreadId ?? firstUnreadId;
    if (!targetId) return;
    const threadTarget = threadContent.current?.querySelector<HTMLElement>(
      `[data-message-id="${targetId}"]`,
    );
    if (threadTarget) {
      threadTarget.scrollIntoView({ block: "center", behavior: "smooth" });
      threadPinnedToBottom.current = false;
      return;
    }
    const findAndScroll = () => {
      const target = timelineScroller.current?.querySelector<HTMLElement>(
        `[data-message-id="${targetId}"]`,
      );
      if (!target) return false;
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      timelinePinnedToBottom.current = false;
      return true;
    };
    if (findAndScroll()) return;
    const candidate = navigation.snapshot.candidates.find(
      (item) => item.id === targetId,
    );
    if (candidate?.rootId) {
      const rootId = candidate.rootId;
      startNavigation(() => {
        router.push(
          `/channels/${initial.selectedChannel.id}?${new URLSearchParams({
            thread: rootId,
            message: candidate.id,
          })}`,
          { scroll: false },
        );
      });
      return;
    }
    let cursor = timelineCursor;
    let hasMore = timelineHasMore;
    const loaded: typeof timeline = [];
    try {
      while (cursor && hasMore && loaded.length < 2_000) {
        const response = await fetch(
          `/api/channels/${initial.selectedChannel.id}/history?${new URLSearchParams(
            {
              created_at: String(cursor.createdAt),
              id: cursor.id,
            },
          )}`,
          { cache: "no-store" },
        );
        const page = (await response.json()) as ChannelHistoryPage & {
          error?: string;
        };
        if (!response.ok) {
          throw new Error(
            page.error || "First unread message could not be loaded",
          );
        }
        loaded.push(...page.messages);
        const advanced =
          page.nextCursor &&
          (page.nextCursor.createdAt !== cursor.createdAt ||
            page.nextCursor.id !== cursor.id);
        cursor = advanced ? page.nextCursor : null;
        hasMore = page.hasMore && page.messages.length > 0 && Boolean(advanced);
        if (page.messages.some((message) => message.id === targetId)) break;
      }
      setOlderTimeline((current) => [
        ...new Map(
          [...loaded, ...current].map((message) => [message.id, message]),
        ).values(),
      ]);
      setTimelineCursor(cursor);
      setTimelineHasMore(hasMore);
      historyLoaded.current = true;
      requestAnimationFrame(() => requestAnimationFrame(findAndScroll));
    } catch (caught) {
      setHistoryError(
        caught instanceof Error
          ? caught.message
          : "First unread message could not be loaded",
      );
    }
  }, [
    firstThreadUnreadId,
    firstUnreadId,
    initial.selectedChannel.id,
    navigation.snapshot.candidates,
    router,
    timelineCursor,
    timelineHasMore,
  ]);

  const targetInThread = Boolean(
    targetMessageId &&
      (thread?.root?.id === targetMessageId ||
        thread?.replies.some((message) => message.id === targetMessageId)),
  );

  useEffect(() => {
    const scroller = threadScroller.current;
    const content = threadContent.current;
    if (!openThreadId || !scroller || !content) return;
    const target =
      targetInThread && targetMessageId
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
  }, [openThreadId, targetMessageId, targetInThread]);

  const targetInTimeline = renderedTimeline.some(
    (message) => message.id === targetMessageId,
  );

  useEffect(() => {
    if (openThreadId || !targetMessageId) return;
    if (!targetInTimeline) return;
    const target = timelineScroller.current?.querySelector<HTMLElement>(
      `[data-message-id="${targetMessageId}"]`,
    );
    if (!target) return;
    const frame = requestAnimationFrame(() => {
      target.scrollIntoView({ block: "center" });
      timelinePinnedToBottom.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [openThreadId, targetInTimeline, targetMessageId]);

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
  const threadPanelWidth =
    viewportWidth === null
      ? null
      : clampThreadPanelWidth(
          preferredThreadPanelWidth ?? defaultThreadPanelWidth(viewportWidth),
          viewportWidth,
        );
  const threadPanelBounds =
    viewportWidth === null ? null : threadPanelWidthBounds(viewportWidth);
  const workspaceStyle =
    threadPanelWidth === null
      ? undefined
      : ({
          "--thread-panel-width": `${threadPanelWidth}px`,
        } as WorkspaceStyle);

  const updateThreadPanelWidth = (width: number): number => {
    const next = clampThreadPanelWidth(width, window.innerWidth);
    threadPanelWidthRef.current = next;
    setPreferredThreadPanelWidth(next);
    return next;
  };

  const finishThreadPanelResize = useCallback(
    (event: ReactPointerEvent<HTMLHRElement>) => {
      const resize = threadResize.current;
      if (!resize || resize.pointerId !== event.pointerId) return;
      threadResize.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      setThreadPanelResizing(false);
      const width = threadPanelWidthRef.current;
      if (width !== null) writeThreadPanelWidth(window.localStorage, width);
    },
    [],
  );

  return (
    <ChannelPinsContext.Provider value={pins}>
      {navigationPending ? <NavigationProgress /> : null}
      <main
        className={`${thread ? "workspace workspace-thread-open" : "workspace"}${mobileNavOpen ? " mobile-nav-open" : ""}${threadPanelResizing ? " workspace-thread-resizing" : ""}`}
        data-cache-state={initial.cacheState}
        style={workspaceStyle}
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
              <PinnedMessages
                channel={initial.selectedChannel}
                channels={initial.channels}
              />
              {firstUnreadId || firstThreadUnreadId ? (
                <button
                  className="jump-unread-button"
                  onClick={() => void jumpToFirstUnread()}
                  type="button"
                >
                  First unread
                </button>
              ) : null}
              <ViewRefreshIndicator active={revalidating} />
              <span className={`live-status live-${liveState}`}>
                <span /> {liveLabel}
              </span>
              <button
                aria-label="Channel members"
                onClick={() => setMembersOpen(true)}
                title="Channel members and settings"
                type="button"
              >
                <Users aria-hidden="true" size={18} />
              </button>
            </div>
          </header>
          {membersOpen ? (
            <ConversationDialog
              key={initial.selectedChannel.id}
              identity={initial.identity.pubkey}
              channelId={initial.selectedChannel.id}
              close={() => setMembersOpen(false)}
            />
          ) : null}

          <div
            className="timeline"
            data-image-gallery
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
                <div className="timeline-message" key={message.id}>
                  {message.id === firstUnreadId ? (
                    <div className="new-messages-divider">
                      <span>New messages</span>
                      <i />
                    </div>
                  ) : null}
                  <MessageRow
                    channelId={initial.selectedChannel.id}
                    channels={initial.channels}
                    expectedPubkey={initial.identity.pubkey}
                    message={message}
                    onContextReply={() => openMessageThread(message.id)}
                    onMessageChange={(next) => updateMessage(message.id, next)}
                    onUnreadChange={(unread) => {
                      if (unread) {
                        navigation.controller.markMessageUnread(
                          initial.selectedChannel.id,
                          message.id,
                        );
                      } else {
                        navigation.controller.markMessageRead(
                          message.id,
                          message.createdAt,
                        );
                      }
                    }}
                  />
                </div>
              ))
            )}
            <div ref={timelineEnd} />
          </div>
          <Composer
            channelId={initial.selectedChannel.id}
            channelName={initial.selectedChannel.name}
            expectedPubkey={initial.identity.pubkey}
            forum={forum}
            archived={initial.selectedChannel.archived}
            typingParticipants={typingParticipants.channel}
          />
        </section>

        {thread ? (
          <aside className="thread-panel">
            <hr
              aria-label="Resize thread panel"
              aria-orientation="vertical"
              aria-valuemax={threadPanelBounds?.max}
              aria-valuemin={threadPanelBounds?.min}
              aria-valuenow={threadPanelWidth ?? undefined}
              aria-valuetext={
                threadPanelWidth === null
                  ? undefined
                  : `${threadPanelWidth} pixels wide`
              }
              className="thread-panel-resize-handle"
              onKeyDown={(event) => {
                if (threadPanelWidth === null || threadPanelBounds === null) {
                  return;
                }
                let next: number;
                switch (event.key) {
                  case "ArrowLeft":
                    next = threadPanelWidth + (event.shiftKey ? 50 : 16);
                    break;
                  case "ArrowRight":
                    next = threadPanelWidth - (event.shiftKey ? 50 : 16);
                    break;
                  case "Home":
                    next = threadPanelBounds.min;
                    break;
                  case "End":
                    next = threadPanelBounds.max;
                    break;
                  default:
                    return;
                }
                event.preventDefault();
                writeThreadPanelWidth(
                  window.localStorage,
                  updateThreadPanelWidth(next),
                );
              }}
              onLostPointerCapture={finishThreadPanelResize}
              onPointerCancel={finishThreadPanelResize}
              onPointerDown={(event) => {
                if (event.button !== 0 || threadPanelWidth === null) return;
                event.preventDefault();
                threadPanelWidthRef.current = threadPanelWidth;
                threadResize.current = {
                  pointerId: event.pointerId,
                  startWidth: threadPanelWidth,
                  startX: event.clientX,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
                setThreadPanelResizing(true);
              }}
              onPointerMove={(event) => {
                const resize = threadResize.current;
                if (!resize || resize.pointerId !== event.pointerId) return;
                event.preventDefault();
                updateThreadPanelWidth(
                  resize.startWidth + resize.startX - event.clientX,
                );
              }}
              onPointerUp={finishThreadPanelResize}
              tabIndex={0}
              title="Drag to resize the thread panel"
            />
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
              <div
                className="thread-messages-content"
                data-image-gallery
                ref={threadContent}
              >
                {thread.root ? (
                  <MessageRow
                    channelId={initial.selectedChannel.id}
                    channels={initial.channels}
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
                  <div className="thread-message" key={message.id}>
                    {message.id === firstThreadUnreadId ? (
                      <div className="new-messages-divider">
                        <span>New replies</span>
                        <i />
                      </div>
                    ) : null}
                    <MessageRow
                      channelId={initial.selectedChannel.id}
                      channels={initial.channels}
                      compact
                      expectedPubkey={initial.identity.pubkey}
                      highlighted={message.id === targetMessageId}
                      message={message}
                      onMessageChange={(next) =>
                        updateMessage(message.id, next)
                      }
                      onReply={() =>
                        setReplyTarget({
                          id: message.id,
                          name: message.author.name,
                        })
                      }
                      onUnreadChange={(unread) => {
                        if (unread) {
                          navigation.controller.markMessageUnread(
                            initial.selectedChannel.id,
                            message.id,
                          );
                        } else {
                          navigation.controller.markMessageRead(
                            message.id,
                            message.createdAt,
                          );
                        }
                      }}
                      replyingTo={
                        message.parentId && message.parentId !== thread.rootId
                          ? (threadAuthors.get(message.parentId) ??
                            "a previous reply")
                          : null
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
            <Composer
              channelId={initial.selectedChannel.id}
              channelName={initial.selectedChannel.name}
              expectedPubkey={initial.identity.pubkey}
              forum={forum}
              archived={initial.selectedChannel.archived}
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
      </main>
    </ChannelPinsContext.Provider>
  );
}
