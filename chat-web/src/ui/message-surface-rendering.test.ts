import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  ActivityItemView,
  ChannelView,
  InboxItemView,
  MessageView,
  SearchResultView,
  SentItemView,
  ThreadSummaryView,
} from "@/server/types";
import { ActivityRow } from "@/ui/ActivityShell";
import { InboxRow } from "@/ui/InboxShell";
import { SearchResult } from "@/ui/SearchDialog";
import { SentRow } from "@/ui/SentShell";
import { ThreadSurfaceRow } from "@/ui/ThreadsShell";

const channel: ChannelView = {
  id: "channel",
  name: "general",
  description: "",
  type: "stream",
  visibility: "private",
  archived: false,
};
const author = {
  pubkey: "a".repeat(64),
  name: "Alice",
  picture: null,
  initials: "A",
  color: "#123456",
};
const content = "**Rich** `message` with [a link](https://example.com).";
const message: MessageView = {
  id: "b".repeat(64),
  threadRootId: null,
  parentId: null,
  author,
  content,
  createdAt: 100,
  editedAt: null,
  isOwn: false,
  replyCount: 2,
  lastReplyAt: 110,
  replyParticipants: [],
  reactions: [{ emoji: "👍", count: 2, reactedByMe: false }],
};

function assertRichMessage(markup: string) {
  assert.match(markup, /class="message-body"/);
  assert.match(markup, /<strong>Rich<\/strong>/);
  assert.match(markup, /<code>message<\/code>/);
  assert.match(markup, /href="https:\/\/example\.com"/);
}

test("every message index surface uses the canonical rich body", () => {
  const inbox: InboxItemView = {
    id: message.id,
    conversationId: message.id,
    channel,
    threadId: message.id,
    author,
    content,
    createdAt: 100,
    categories: ["mention"],
    itemCount: 1,
  };
  const activity: ActivityItemView = {
    id: message.id,
    conversationId: message.id,
    channel,
    threadId: message.id,
    author,
    content,
    createdAt: 100,
    kind: "message",
    itemCount: 1,
    isOwn: false,
  };
  const sent: SentItemView = {
    id: message.id,
    channel,
    threadId: message.id,
    message,
  };
  const thread: ThreadSummaryView = {
    channel,
    root: message,
    activityAt: 110,
  };
  const search: SearchResultView = {
    id: message.id,
    channelId: channel.id,
    channelName: channel.name,
    threadId: message.id,
    author,
    content,
    createdAt: 100,
    isOwn: false,
  };

  const surfaces = [
    createElement(InboxRow, {
      channels: [channel],
      generatedAt: 120_000,
      item: inbox,
    }),
    createElement(ActivityRow, {
      channels: [channel],
      generatedAt: 120_000,
      item: activity,
    }),
    createElement(SentRow, {
      channels: [channel],
      generatedAt: 120_000,
      item: sent,
    }),
    createElement(ThreadSurfaceRow, {
      channels: [channel],
      generatedAt: 120_000,
      summary: thread,
      unread: { unreadCount: 1, highPriorityCount: 0 },
    }),
    createElement(SearchResult, {
      channels: [channel],
      onOpen: () => undefined,
      result: search,
    }),
  ];

  for (const surface of surfaces) {
    assertRichMessage(renderToStaticMarkup(surface));
  }
});
