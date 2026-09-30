import "server-only";

import { createHash } from "node:crypto";

import type { AuthSession } from "@/server/auth";
import { getServerConfig } from "@/server/env";
import {
  fallbackProfile,
  projectChannels,
  projectProfiles,
  projectThread,
  projectThreadIndex,
  projectTimeline,
} from "@/server/projector";
import {
  loadChannelMessageWindow,
  loadCompleteChannelHistory,
  loadProjectionAuxClosure,
  loadProjectionAuxClosureForChannels,
} from "@/server/projection-events";
import type { RelayFilter } from "@/server/relay";
import type {
  ChannelHistoryPage,
  ChannelSnapshot,
  ChannelTimelineCursor,
  ChannelView,
  ThreadsWorkspaceView,
  WorkspaceView,
} from "@/server/types";
import { includePinnedReplies, loadChannelPins } from "@/server/pins";
import { ViewCache } from "@/server/view-cache";

const CHANNEL_WINDOW_LIMIT = 20;
const THREAD_WINDOW_LIMIT = 100;
const INDEX_STALE_AFTER_MS = 10_000;
const WORKSPACE_STALE_AFTER_MS = 3_000;
const THREADS_STALE_AFTER_MS = 15_000;
const HISTORY_STALE_AFTER_MS = 10_000;
const THREAD_PREWARM_LIMIT = 20;
const THREAD_PREWARM_TARGET_LIMIT = 200;
const CHANNEL_MESSAGE_KINDS = [9, 40002, 40008, 45001, 45003];

type WorkspaceIndex = {
  channels: ChannelView[];
  defaultChannel: ChannelView | null;
};

type WorkspacePayload = Omit<WorkspaceView, "cacheState">;
type ThreadsWorkspacePayload = Omit<ThreadsWorkspaceView, "cacheState">;
type ChannelHistoryPayload = Omit<ChannelHistoryPage, "cacheState">;

const workspaceIndexCache = new ViewCache<WorkspaceIndex>({
  maxEntries: 128,
  staleAfterMs: INDEX_STALE_AFTER_MS,
});
const workspaceCache = new ViewCache<WorkspacePayload>({
  maxEntries: 512,
  staleAfterMs: WORKSPACE_STALE_AFTER_MS,
});
const threadsCache = new ViewCache<ThreadsWorkspacePayload>({
  maxEntries: 128,
  staleAfterMs: THREADS_STALE_AFTER_MS,
});
const historyCache = new ViewCache<ChannelHistoryPayload>({
  maxEntries: 1_024,
  staleAfterMs: HISTORY_STALE_AFTER_MS,
});

export class UnknownChannelError extends Error {}

function baseFilters(viewerPubkey: string): RelayFilter[] {
  return [
    { kinds: [39002], "#p": [viewerPubkey], limit: 500 },
    { kinds: [39000], limit: 500 },
  ];
}

function threadFilters(channelId: string, rootId: string): RelayFilter[] {
  return [
    { ids: [rootId], limit: 1 },
    {
      kinds: [9, 39005, 40002, 40008, 45003],
      "#h": [channelId],
      "#e": [rootId],
      limit: THREAD_WINDOW_LIMIT * 2,
    },
  ];
}

function mergeEvents<T extends { id: string }>(...groups: T[][]): T[] {
  return [...new Map(groups.flat().map((event) => [event.id, event])).values()];
}

function timelinePageFromCompleteHistory(
  timeline: ReturnType<typeof projectTimeline>,
): {
  messages: ReturnType<typeof projectTimeline>;
  hasMore: boolean;
  nextCursor: ChannelTimelineCursor | null;
} {
  const messages = timeline.slice(-CHANNEL_WINDOW_LIMIT);
  const first = messages[0];
  return {
    messages,
    hasMore: timeline.length > messages.length,
    nextCursor:
      timeline.length > messages.length && first
        ? { createdAt: first.createdAt, id: first.id }
        : null,
  };
}

function profileFilter(events: { pubkey: string }[], viewerPubkey: string) {
  const authors = [
    ...new Set([viewerPubkey, ...events.map((event) => event.pubkey)]),
  ].slice(0, 500);
  return { kinds: [0], authors, limit: authors.length };
}

function pickDefaultChannel(channels: ChannelView[]): ChannelView | null {
  const configured = getServerConfig().defaultChannelId;
  return (
    channels.find((channel) => channel.id === configured) ??
    channels.find(
      (channel) => !channel.archived && channel.type === "stream",
    ) ??
    channels.find((channel) => !channel.archived) ??
    channels[0] ??
    null
  );
}

async function loadWorkspaceIndexFresh(
  session: AuthSession,
): Promise<WorkspaceIndex> {
  const events = await session.relay.query(baseFilters(session.pubkey));
  const channels = projectChannels(events, session.pubkey);
  return { channels, defaultChannel: pickDefaultChannel(channels) };
}

export async function loadWorkspaceIndex(
  session: AuthSession,
): Promise<WorkspaceIndex> {
  return (
    await workspaceIndexCache.get(session.cacheScope, () =>
      loadWorkspaceIndexFresh(session),
    )
  ).value;
}

async function loadThreadsWorkspaceFresh(
  session: AuthSession,
): Promise<ThreadsWorkspacePayload> {
  const index = await loadWorkspaceIndex(session);
  const { channels } = index;
  const [historyGroups, deletions] = await Promise.all([
    Promise.all(
      channels.map((channel) =>
        loadCompleteChannelHistory(
          (filters) => session.relay.query(filters),
          channel.id,
        ),
      ),
    ),
    channels.length > 0
      ? session.relay.query([
          {
            kinds: [5, 9005],
            "#h": channels.map((channel) => channel.id),
            limit: 500,
          },
        ])
      : Promise.resolve([]),
  ]);
  const baseEventGroups = channels.map((channel, index) =>
    mergeEvents(
      historyGroups[index] ?? [],
      deletions.filter((event) =>
        event.tags.some((tag) => tag[0] === "h" && tag[1] === channel.id),
      ),
    ),
  );
  const provisionalEvents = mergeEvents(...baseEventGroups);
  const provisionalThreads = projectThreadIndex(
    provisionalEvents,
    channels,
    new Map(),
    session.pubkey,
  );
  const targetIdsByChannel = new Map(
    channels.map((channel) => [channel.id, new Set<string>()] as const),
  );
  for (const summary of provisionalThreads) {
    targetIdsByChannel.get(summary.channel.id)?.add(summary.root.id);
  }
  const prewarmedThreadIds = new Set<string>();
  let prewarmedThreadTargetCount = 0;
  for (const summary of provisionalThreads.slice(0, THREAD_PREWARM_LIMIT)) {
    const channelIndex = channels.findIndex(
      (channel) => channel.id === summary.channel.id,
    );
    const thread = projectThread(
      baseEventGroups[channelIndex] ?? [],
      summary.channel.id,
      summary.root.id,
      new Map(),
      session.pubkey,
    );
    const targets = targetIdsByChannel.get(summary.channel.id);
    if (!targets) continue;
    const threadTargetIds = thread.replies.map((message) => message.id);
    const additionalTargetIds = threadTargetIds.filter(
      (id) => !targets.has(id),
    );
    if (
      prewarmedThreadTargetCount + additionalTargetIds.length >
      THREAD_PREWARM_TARGET_LIMIT
    ) {
      continue;
    }
    for (const id of additionalTargetIds) targets.add(id);
    prewarmedThreadTargetCount += additionalTargetIds.length;
    prewarmedThreadIds.add(summary.root.id);
  }
  const auxiliary = await loadProjectionAuxClosureForChannels(
    (filters) => session.relay.query(filters),
    channels.map((channel) => channel.id),
    [...targetIdsByChannel.values()].flatMap((targets) => [...targets]),
  );
  const eventGroups = baseEventGroups.map((group, index) =>
    mergeEvents(
      group,
      auxiliary.filter((event) =>
        event.tags.some(
          (tag) => tag[0] === "h" && tag[1] === channels[index]?.id,
        ),
      ),
    ),
  );
  const events = mergeEvents(...eventGroups);
  const profileEvents = await session.relay.query([
    profileFilter(events, session.pubkey),
  ]);
  const profiles = projectProfiles(profileEvents);
  const identity =
    profiles.get(session.pubkey) ?? fallbackProfile(session.pubkey);
  const threads = projectThreadIndex(
    events,
    channels,
    profiles,
    session.pubkey,
  );
  const generatedAt = Date.now();
  const timelinePages = new Map(
    channels.map((channel, index) => [
      channel.id,
      timelinePageFromCompleteHistory(
        projectTimeline(
          eventGroups[index] ?? [],
          channel.id,
          profiles,
          session.pubkey,
        ),
      ),
    ]),
  );
  const pinGroups = await Promise.all(
    channels.map((channel) =>
      loadChannelPins(
        (filters) => session.relay.query(filters),
        channel.id,
        session.pubkey,
      ),
    ),
  );
  const pinsByChannel = new Map(
    channels.map((channel, index) => [channel.id, pinGroups[index]]),
  );
  for (const channel of channels) {
    const page = timelinePages.get(channel.id);
    workspaceCache.set(workspaceCacheKey(session, channel.id, null), {
      identity,
      channels,
      selectedChannel: channel,
      pins: pinsByChannel.get(channel.id) ?? [],
      timeline: page?.messages ?? [],
      timelineHasMore: page?.hasMore ?? false,
      timelineCursor: page?.nextCursor ?? null,
      thread: null,
      generatedAt,
    });
  }
  for (const summary of threads.filter((summary) =>
    prewarmedThreadIds.has(summary.root.id),
  )) {
    const channelIndex = channels.findIndex(
      (channel) => channel.id === summary.channel.id,
    );
    const page = timelinePages.get(summary.channel.id);
    workspaceCache.set(
      workspaceCacheKey(session, summary.channel.id, summary.root.id),
      {
        identity,
        channels,
        selectedChannel: summary.channel,
        pins: pinsByChannel.get(summary.channel.id) ?? [],
        timeline: page?.messages ?? [],
        timelineHasMore: page?.hasMore ?? false,
        timelineCursor: page?.nextCursor ?? null,
        thread: projectThread(
          eventGroups[channelIndex] ?? [],
          summary.channel.id,
          summary.root.id,
          profiles,
          session.pubkey,
        ),
        generatedAt,
      },
    );
  }
  return {
    identity,
    channels,
    threads,
    generatedAt,
  };
}

export async function loadThreadsWorkspace(
  session: AuthSession,
): Promise<ThreadsWorkspaceView> {
  const result = await threadsCache.get(session.cacheScope, () =>
    loadThreadsWorkspaceFresh(session),
  );
  return { ...result.value, cacheState: result.state };
}

export async function refreshThreadsWorkspace(
  session: AuthSession,
): Promise<ThreadsWorkspaceView> {
  const result = await threadsCache.refresh(session.cacheScope, () =>
    loadThreadsWorkspaceFresh(session),
  );
  return { ...result.value, cacheState: result.state };
}

function workspaceCacheKey(
  session: AuthSession,
  channelId: string,
  rootId: string | null,
): string {
  return `${session.cacheScope}:${channelId}:${rootId ?? "channel"}`;
}

async function loadWorkspaceFresh(
  session: AuthSession,
  channelId: string,
  rootId: string | null,
): Promise<WorkspacePayload> {
  const [{ channels }, messageWindow, threadEvents, pins] = await Promise.all([
    loadWorkspaceIndex(session),
    loadChannelMessageWindow(
      (filters) => session.relay.query(filters),
      channelId,
      session.pubkey,
      null,
      CHANNEL_WINDOW_LIMIT,
    ),
    rootId
      ? session.relay.query(threadFilters(channelId, rootId))
      : Promise.resolve([]),
    loadChannelPins(
      (filters) => session.relay.query(filters),
      channelId,
      session.pubkey,
    ),
  ]);
  const threadMessageEvents = threadEvents.filter((event) =>
    CHANNEL_MESSAGE_KINDS.includes(event.kind),
  );
  const threadDecorations = rootId
    ? await loadProjectionAuxClosure(
        (filters) => session.relay.query(filters),
        channelId,
        threadMessageEvents.map((event) => event.id),
      )
    : [];
  const combined = mergeEvents(
    messageWindow.events,
    threadEvents,
    threadDecorations,
  );
  const visibleTimelineIds = new Set(
    projectTimeline(messageWindow.events, channelId, new Map(), session.pubkey)
      .slice(-CHANNEL_WINDOW_LIMIT)
      .map((message) => message.id),
  );
  const profileSources = mergeEvents(
    messageWindow.events.filter((event) => visibleTimelineIds.has(event.id)),
    threadMessageEvents,
  );
  const profileEvents = await session.relay.query([
    profileFilter(profileSources, session.pubkey),
  ]);
  const viewerPubkey = session.pubkey;
  const selectedChannel = channels.find((channel) => channel.id === channelId);
  if (!selectedChannel) {
    throw new UnknownChannelError(`Channel ${channelId} is not available`);
  }
  const profiles = projectProfiles(profileEvents);
  const identity = profiles.get(viewerPubkey) ?? fallbackProfile(viewerPubkey);
  const timeline = projectTimeline(
    combined,
    channelId,
    profiles,
    viewerPubkey,
  ).slice(-CHANNEL_WINDOW_LIMIT);
  const projectedThread = rootId
    ? projectThread(combined, channelId, rootId, profiles, viewerPubkey)
    : null;
  // If a relay omits the explicit root lookup but the root is still in the
  // channel window, reuse that server-projected row rather than making the
  // browser repair the shape.
  if (projectedThread && !projectedThread.root) {
    projectedThread.root =
      timeline.find((message) => message.id === rootId) ?? null;
  }
  return {
    identity,
    channels,
    selectedChannel,
    pins,
    timeline,
    timelineHasMore: messageWindow.hasMore,
    timelineCursor: messageWindow.nextCursor,
    thread: projectedThread
      ? includePinnedReplies(projectedThread, pins)
      : null,
    generatedAt: Date.now(),
  };
}

export async function loadWorkspace(
  session: AuthSession,
  channelId: string,
  rootId: string | null,
): Promise<WorkspaceView> {
  const key = workspaceCacheKey(session, channelId, rootId);
  const result = await workspaceCache.get(key, () =>
    loadWorkspaceFresh(session, channelId, rootId),
  );
  return { ...result.value, cacheState: result.state };
}

export function markWorkspaceViewsStale(
  session: AuthSession,
  channelId?: string,
): void {
  const prefix = `${session.cacheScope}:`;
  const channelPrefix = channelId ? `${prefix}${channelId}:` : prefix;
  workspaceCache.markStale((key) => key.startsWith(channelPrefix));
  workspaceIndexCache.markStale((key) => key === session.cacheScope);
  threadsCache.markStale((key) => key === session.cacheScope);
  historyCache.markStale((key) => key.startsWith(channelPrefix));
}

function historyCacheKey(
  session: AuthSession,
  channelId: string,
  cursor: ChannelTimelineCursor,
): string {
  return `${session.cacheScope}:${channelId}:${cursor.createdAt}:${cursor.id}`;
}

async function loadChannelHistoryPageFresh(
  session: AuthSession,
  channelId: string,
  cursor: ChannelTimelineCursor,
): Promise<ChannelHistoryPayload> {
  const { channels } = await loadWorkspaceIndex(session);
  if (!channels.some((channel) => channel.id === channelId)) {
    throw new UnknownChannelError(`Channel ${channelId} is not available`);
  }
  const messageWindow = await loadChannelMessageWindow(
    (filters) => session.relay.query(filters),
    channelId,
    session.pubkey,
    cursor,
    CHANNEL_WINDOW_LIMIT,
  );
  const profileEvents = await session.relay.query([
    profileFilter(
      messageWindow.events.filter((event) =>
        CHANNEL_MESSAGE_KINDS.includes(event.kind),
      ),
      session.pubkey,
    ),
  ]);
  return {
    messages: projectTimeline(
      messageWindow.events,
      channelId,
      projectProfiles(profileEvents),
      session.pubkey,
    ).slice(-CHANNEL_WINDOW_LIMIT),
    hasMore: messageWindow.hasMore,
    nextCursor: messageWindow.nextCursor,
    generatedAt: Date.now(),
  };
}

export async function loadChannelHistoryPage(
  session: AuthSession,
  channelId: string,
  cursor: ChannelTimelineCursor,
  fresh = false,
): Promise<ChannelHistoryPage> {
  const result = await historyCache[fresh ? "refresh" : "get"](
    historyCacheKey(session, channelId, cursor),
    () => loadChannelHistoryPageFresh(session, channelId, cursor),
  );
  return { ...result.value, cacheState: result.state };
}

export async function loadChannelSnapshot(
  session: AuthSession,
  channelId: string,
  rootId: string | null,
): Promise<ChannelSnapshot> {
  const key = workspaceCacheKey(session, channelId, rootId);
  const workspace = (
    await workspaceCache.refresh(key, () =>
      loadWorkspaceFresh(session, channelId, rootId),
    )
  ).value;
  const snapshot = {
    selectedChannel: workspace.selectedChannel,
    pins: workspace.pins,
    timeline: workspace.timeline,
    timelineHasMore: workspace.timelineHasMore,
    timelineCursor: workspace.timelineCursor,
    thread: workspace.thread,
    generatedAt: workspace.generatedAt,
  };
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        selectedChannel: snapshot.selectedChannel,
        pins: snapshot.pins,
        timeline: snapshot.timeline,
        timelineHasMore: snapshot.timelineHasMore,
        timelineCursor: snapshot.timelineCursor,
        thread: snapshot.thread,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return { ...snapshot, revision };
}
