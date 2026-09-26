import assert from "node:assert/strict";
import test from "node:test";

import type { ChannelSnapshot, MessageView } from "@/server/types";
import {
  clearCompletedTyping,
  registerTypingEntry,
} from "@/client/typing-state";

const message = (pubkey: string, createdAt: number): MessageView => ({
  id: "a".repeat(64),
  threadRootId: null,
  parentId: null,
  author: {
    pubkey,
    name: pubkey,
    picture: null,
    initials: "T",
    color: "#000",
  },
  content: "sent",
  createdAt,
  editedAt: null,
  isOwn: false,
  replyCount: 0,
  lastReplyAt: null,
  replyParticipants: [],
  reactions: [],
});

const snapshot = (timeline: MessageView[]): ChannelSnapshot => ({
  pins: [],
  selectedChannel: {
    id: "00000000-0000-4000-8000-000000000001",
    name: "general",
    description: "",
    type: "stream",
    visibility: "private",
    archived: false,
  },
  timeline,
  timelineHasMore: false,
  timelineCursor: null,
  thread: null,
  generatedAt: 1_000,
  revision: "revision",
});

test("typing state excludes the viewer and expires remote indicators", () => {
  assert.deepEqual(
    registerTypingEntry(
      [],
      { pubkey: "viewer", threadHeadId: null, createdAt: 10 },
      "viewer",
      10_000,
    ),
    [],
  );
  assert.deepEqual(
    registerTypingEntry(
      [],
      { pubkey: "remote", threadHeadId: null, createdAt: 1 },
      "viewer",
      10_000,
    ),
    [],
  );
});

test("typing state keeps scopes separate and clears on send", () => {
  const channel = registerTypingEntry(
    [],
    { pubkey: "remote", threadHeadId: null, createdAt: 10 },
    "viewer",
    10_000,
  );
  const both = registerTypingEntry(
    channel,
    { pubkey: "remote", threadHeadId: "b".repeat(64), createdAt: 11 },
    "viewer",
    11_000,
  );
  assert.equal(both.length, 2);
  assert.deepEqual(
    clearCompletedTyping(both, snapshot([message("remote", 10)]), 11_000),
    [
      {
        pubkey: "remote",
        threadHeadId: "b".repeat(64),
        createdAt: 11,
        expiresAt: 19_000,
      },
    ],
  );
});
