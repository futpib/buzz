import "server-only";

import { createHash } from "node:crypto";

import { getServerConfig } from "@/server/env";
import {
  fallbackProfile,
  projectChannels,
  projectProfiles,
  projectThread,
  projectTimeline,
} from "@/server/projector";
import { queryRelay, type RelayFilter } from "@/server/relay";
import { serverPubkey } from "@/server/nostr";
import type {
  ChannelSnapshot,
  ChannelView,
  WorkspaceView,
} from "@/server/types";

const CHANNEL_WINDOW_LIMIT = 80;
const THREAD_WINDOW_LIMIT = 100;

export class UnknownChannelError extends Error {}

function baseFilters(channelId?: string): RelayFilter[] {
  const filters: RelayFilter[] = [
    { kinds: [39002], "#p": [serverPubkey()], limit: 500 },
    { kinds: [39000], limit: 500 },
    { kinds: [0], limit: 500 },
  ];
  if (channelId) {
    filters.push(
      { kinds: [39002], "#d": [channelId], limit: 1 },
      {
        kinds: [9, 40002, 40008, 45001],
        "#h": [channelId],
        limit: CHANNEL_WINDOW_LIMIT,
        top_level: true,
        include_summaries: true,
        include_aux: true,
      },
    );
  }
  return filters;
}

function threadFilter(channelId: string, rootId: string): RelayFilter {
  return {
    kinds: [9, 40002, 40008, 45003],
    "#h": [channelId],
    "#e": [rootId],
    limit: THREAD_WINDOW_LIMIT,
    thread_window: true,
    thread_parent: rootId,
    depth_limit: 64,
    include_aux: true,
  };
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

export async function loadWorkspaceIndex(): Promise<{
  channels: ChannelView[];
  defaultChannel: ChannelView | null;
}> {
  const events = await queryRelay(baseFilters());
  const channels = projectChannels(events, serverPubkey());
  return { channels, defaultChannel: pickDefaultChannel(channels) };
}

export async function loadWorkspace(
  channelId: string,
  rootId: string | null,
): Promise<WorkspaceView> {
  const [events, threadEvents] = await Promise.all([
    queryRelay(baseFilters(channelId)),
    rootId
      ? queryRelay([threadFilter(channelId, rootId)])
      : Promise.resolve([]),
  ]);
  const viewerPubkey = serverPubkey();
  const channels = projectChannels(events, viewerPubkey);
  const selectedChannel = channels.find((channel) => channel.id === channelId);
  if (!selectedChannel) {
    throw new UnknownChannelError(`Channel ${channelId} is not available`);
  }
  const profiles = projectProfiles([...events, ...threadEvents]);
  const identity = profiles.get(viewerPubkey) ?? fallbackProfile(viewerPubkey);
  const timeline = projectTimeline(events, channelId, profiles, viewerPubkey);
  const projectedThread = rootId
    ? projectThread(threadEvents, channelId, rootId, profiles, viewerPubkey)
    : null;
  // The channel window already carries the authoritative visible head. Older
  // relay builds may omit that head from a thread-window response while still
  // returning its replies, so reuse the same server-projected row instead of
  // making the browser repair the shape.
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
  channelId: string,
  rootId: string | null,
): Promise<ChannelSnapshot> {
  const workspace = await loadWorkspace(channelId, rootId);
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
