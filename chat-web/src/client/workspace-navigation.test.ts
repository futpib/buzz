import assert from "node:assert/strict";
import test from "node:test";

import {
  navigationMetaForChannel,
  navigationPublishRetryDelay,
  navigationReadContextsForChannel,
  type NavigationSnapshot,
  navigationUnreadForThread,
} from "./workspace-navigation";

const base: NavigationSnapshot = {
  version: 1,
  clientId: "web-test",
  readContexts: { channel: 10 },
  forcedUnread: {},
  stars: {},
  mutes: {},
  sections: [],
  assignments: {},
  sort: {},
  notifications: false,
  archivedOpen: false,
  pendingPublishes: [],
  ready: true,
  candidates: [
    {
      id: "a".repeat(64),
      channelId: "channel",
      channelName: "general",
      channelType: "stream",
      author: {
        pubkey: "b".repeat(64),
        name: "Other",
        picture: null,
        initials: "O",
        color: "#000",
      },
      content: "root",
      createdAt: 11,
      rootId: null,
      parentId: null,
      highPriority: false,
      isOwn: false,
    },
    {
      id: "c".repeat(64),
      channelId: "channel",
      channelName: "general",
      channelType: "stream",
      author: {
        pubkey: "b".repeat(64),
        name: "Other",
        picture: null,
        initials: "O",
        color: "#000",
      },
      content: "mention",
      createdAt: 12,
      rootId: "a".repeat(64),
      parentId: "a".repeat(64),
      highPriority: true,
      isOwn: false,
    },
  ],
  error: null,
};

test("derives channel and thread unread badges from monotonic markers", () => {
  assert.deepEqual(navigationMetaForChannel(base, "channel"), {
    unreadCount: 2,
    highPriorityCount: 1,
    firstUnreadId: "a".repeat(64),
    lastActivityAt: 12,
    muted: false,
    starred: false,
  });
  assert.deepEqual(navigationUnreadForThread(base, "a".repeat(64)), {
    unreadCount: 1,
    highPriorityCount: 1,
    firstUnreadId: "c".repeat(64),
  });
});

test("mute suppresses general badges but preserves priority alerts", () => {
  const snapshot: NavigationSnapshot = {
    ...base,
    mutes: { channel: { value: true, updatedAt: 1 } },
    stars: { channel: { value: true, updatedAt: 1 } },
  };
  const meta = navigationMetaForChannel(snapshot, "channel");
  assert.equal(meta.unreadCount, 1);
  assert.equal(meta.highPriorityCount, 1);
  assert.equal(meta.muted, true);
  assert.equal(meta.starred, true);
});

test("channel markers do not swallow unread thread replies", () => {
  const snapshot: NavigationSnapshot = {
    ...base,
    readContexts: { channel: 20 },
  };
  const channel = navigationMetaForChannel(snapshot, "channel");
  const thread = navigationUnreadForThread(snapshot, "a".repeat(64));
  assert.equal(channel.unreadCount, 1);
  assert.equal(channel.firstUnreadId, "c".repeat(64));
  assert.equal(thread.unreadCount, 1);
});

test("marking a channel read advances its roots and every thread", () => {
  const readContexts = navigationReadContextsForChannel(base, "channel");
  assert.equal(readContexts.channel, 11);
  assert.equal(readContexts[`thread:${"a".repeat(64)}`], 12);
  assert.equal(
    navigationMetaForChannel({ ...base, readContexts }, "channel").unreadCount,
    0,
  );
});

test("navigation publish retries back off to a bounded recovery cadence", () => {
  assert.equal(navigationPublishRetryDelay(1), 2_000);
  assert.equal(navigationPublishRetryDelay(2), 4_000);
  assert.equal(navigationPublishRetryDelay(5), 32_000);
  assert.equal(navigationPublishRetryDelay(6), 60_000);
  assert.equal(navigationPublishRetryDelay(100), 60_000);
});
