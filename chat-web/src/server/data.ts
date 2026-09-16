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
import type { RelayFilter } from "@/server/relay";
import type {
  ChannelSnapshot,
  ChannelView,
  NostrEvent,
  ThreadsWorkspaceView,
  WorkspaceView,
} from "@/server/types";
import { ViewCache } from "@/server/view-cache";

const CHANNEL_WINDOW_LIMIT = 80;
const THREAD_WINDOW_LIMIT = 100;
// Keep each history page comfortably below the relay/WebSocket request timeout.
// The composite cursor makes these bounded pages exhaustive without dropping
// events that share a timestamp.
const THREAD_INDEX_EVENT_LIMIT = 500;
const INDEX_STALE_AFTER_MS = 10_000;
const WORKSPACE_STALE_AFTER_MS = 3_000;
const THREADS_STALE_AFTER_MS = 15_000;
const THREAD_PREWARM_LIMIT = 40;

type WorkspaceIndex = {
  channels: ChannelView[];
  defaultChannel: ChannelView | null;
};

type WorkspacePayload = Omit<WorkspaceView, "cacheState">;
type ThreadsWorkspacePayload = Omit<ThreadsWorkspaceView, "cacheState">;

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

export class UnknownChannelError extends Error {}

function baseFilters(viewerPubkey: string, channelId?: string): RelayFilter[] {
  const filters: RelayFilter[] = [
    { kinds: [39002], "#p": [viewerPubkey], limit: 500 },
    { kinds: [39000], limit: 500 },
  ];
  if (channelId) {
    filters.push(
      {
        kinds: [9, 40002, 40008, 45001, 45003],
        "#h": [channelId],
        limit: CHANNEL_WINDOW_LIMIT * 6,
      },
      {
        kinds: [5, 7, 9005, 39005, 40003],
        "#h": [channelId],
        limit: 500,
      },
    );
  }
  return filters;
}

function threadFilters(channelId: string, rootId: string): RelayFilter[] {
  return [
    { ids: [rootId], limit: 1 },
    {
      kinds: [5, 7, 9, 9005, 39005, 40002, 40003, 40008, 45003],
      "#h": [channelId],
      "#e": [rootId],
      limit: THREAD_WINDOW_LIMIT * 2,
    },
  ];
}

function mergeEvents<T extends { id: string }>(...groups: T[][]): T[] {
  return [...new Map(groups.flat().map((event) => [event.id, event])).values()];
}

async function loadChannelHistory(
  session: AuthSession,
  channelId: string,
): Promise<NostrEvent[]> {
  const events = new Map<string, NostrEvent>();
  let until: number | undefined;
  let beforeId: string | undefined;
  for (;;) {
    const filter: RelayFilter = {
      kinds: [9, 39005, 40002, 40003, 40008, 45001, 45003],
      "#h": [channelId],
      limit: THREAD_INDEX_EVENT_LIMIT,
    };
    if (until !== undefined && beforeId !== undefined) {
      filter.until = until;
      filter.before_id = beforeId;
    }
    const page = await session.relay.query([filter]);
    for (const event of page) events.set(event.id, event);
    if (page.length < THREAD_INDEX_EVENT_LIMIT) break;
    const tail = page.at(-1);
    if (
      !tail ||
      (until === tail.created_at && beforeId === tail.id) ||
      tail.created_at < 0
    ) {
      throw new Error(`Thread history pagination stalled for ${channelId}`);
    }
    until = tail.created_at;
    beforeId = tail.id;
  }
  return [...events.values()];
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
  const index = await loadWorkspaceIndexFresh(session);
  workspaceIndexCache.set(session.cacheScope, index);
  const { channels } = index;
  const eventGroups = await Promise.all(
    channels.map((channel) => loadChannelHistory(session, channel.id)),
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
  const timelines = new Map(
    channels.map((channel, index) => [
      channel.id,
      projectTimeline(
        eventGroups[index] ?? [],
        channel.id,
        profiles,
        session.pubkey,
      ).slice(-CHANNEL_WINDOW_LIMIT),
    ]),
  );
  for (const channel of channels) {
    workspaceCache.set(workspaceCacheKey(session, channel.id, null), {
      identity,
      channels,
      selectedChannel: channel,
      timeline: timelines.get(channel.id) ?? [],
      thread: null,
      generatedAt,
    });
  }
  for (const summary of threads.slice(0, THREAD_PREWARM_LIMIT)) {
    const channelIndex = channels.findIndex(
      (channel) => channel.id === summary.channel.id,
    );
    const channelEvents = eventGroups[channelIndex] ?? [];
    workspaceCache.set(
      workspaceCacheKey(session, summary.channel.id, summary.root.id),
      {
        identity,
        channels,
        selectedChannel: summary.channel,
        timeline: timelines.get(summary.channel.id) ?? [],
        thread: projectThread(
          channelEvents,
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
  const [events, threadEvents] = await Promise.all([
    session.relay.query(baseFilters(session.pubkey, channelId)),
    rootId
      ? session.relay.query(threadFilters(channelId, rootId))
      : Promise.resolve([]),
  ]);
  const combined = mergeEvents(events, threadEvents);
  const profileEvents = await session.relay.query([
    profileFilter(combined, session.pubkey),
  ]);
  const viewerPubkey = session.pubkey;
  const channels = projectChannels(events, viewerPubkey);
  workspaceIndexCache.set(session.cacheScope, {
    channels,
    defaultChannel: pickDefaultChannel(channels),
  });
  const selectedChannel = channels.find((channel) => channel.id === channelId);
  if (!selectedChannel) {
    throw new UnknownChannelError(`Channel ${channelId} is not available`);
  }
  const profiles = projectProfiles(profileEvents);
  const identity = profiles.get(viewerPubkey) ?? fallbackProfile(viewerPubkey);
  const timeline = projectTimeline(combined, channelId, profiles, viewerPubkey);
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
    timeline,
    thread: projectedThread,
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
    timeline: workspace.timeline,
    thread: workspace.thread,
    generatedAt: workspace.generatedAt,
  };
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        selectedChannel: snapshot.selectedChannel,
        timeline: snapshot.timeline,
        thread: snapshot.thread,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return { ...snapshot, revision };
}
