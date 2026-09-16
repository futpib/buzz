import "server-only";

import { createHash } from "node:crypto";

import type { AuthSession } from "@/server/auth";
import { getServerConfig } from "@/server/env";
import {
  fallbackProfile,
  projectChannels,
  projectProfiles,
  projectThread,
  projectTimeline,
} from "@/server/projector";
import type { RelayFilter } from "@/server/relay";
import type {
  ChannelSnapshot,
  ChannelView,
  WorkspaceView,
} from "@/server/types";

const CHANNEL_WINDOW_LIMIT = 80;
const THREAD_WINDOW_LIMIT = 100;

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

export async function loadWorkspaceIndex(session: AuthSession): Promise<{
  channels: ChannelView[];
  defaultChannel: ChannelView | null;
}> {
  const events = await session.relay.query(baseFilters(session.pubkey));
  const channels = projectChannels(events, session.pubkey);
  return { channels, defaultChannel: pickDefaultChannel(channels) };
}

export async function loadWorkspace(
  session: AuthSession,
  channelId: string,
  rootId: string | null,
): Promise<WorkspaceView> {
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

export async function loadChannelSnapshot(
  session: AuthSession,
  channelId: string,
  rootId: string | null,
): Promise<ChannelSnapshot> {
  const workspace = await loadWorkspace(session, channelId, rootId);
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
