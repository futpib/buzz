import assert from "node:assert/strict";
import test from "node:test";

import {
  projectChannels,
  projectProfiles,
  projectThread,
  projectThreadIndex,
  projectTimeline,
} from "./projector";
import type { NostrEvent } from "./types";

function event(
  id: string,
  kind: number,
  content: string,
  tags: string[][],
  pubkey = "a".repeat(64),
  createdAt = 10,
): NostrEvent {
  return {
    id: id.padEnd(64, "0"),
    kind,
    content,
    tags,
    pubkey,
    created_at: createdAt,
    sig: "f".repeat(128),
  };
}

test("projects only channels whose latest roster includes the viewer", () => {
  const viewer = "a".repeat(64);
  const events = [
    event("membership", 39002, "", [
      ["d", "channel-a"],
      ["p", viewer],
    ]),
    event("metadata", 39000, "", [
      ["d", "channel-a"],
      ["name", "general"],
      ["t", "stream"],
      ["public"],
    ]),
  ];
  assert.deepEqual(projectChannels(events, viewer), [
    {
      id: "channel-a",
      name: "general",
      description: "",
      type: "stream",
      visibility: "public",
      archived: false,
    },
  ]);
});

test("applies server-side edits, deletions, reactions, and thread summaries", () => {
  const viewer = "a".repeat(64);
  const other = "b".repeat(64);
  const root = event("root", 9, "before", [["h", "channel-a"]], other, 20);
  const removed = event("removed", 9, "gone", [["h", "channel-a"]], other, 21);
  const edit = event(
    "edit",
    40003,
    "after",
    [
      ["h", "channel-a"],
      ["e", root.id],
    ],
    other,
    22,
  );
  const reaction = event(
    "reaction",
    7,
    "🔥",
    [
      ["h", "channel-a"],
      ["e", root.id],
    ],
    viewer,
    23,
  );
  const deletion = event(
    "deletion",
    5,
    "",
    [
      ["h", "channel-a"],
      ["e", removed.id],
    ],
    other,
    24,
  );
  const summary = event(
    "summary",
    39005,
    JSON.stringify({
      reply_count: 3,
      last_reply_at: 25,
      participants: [other],
    }),
    [
      ["h", "channel-a"],
      ["e", root.id],
      ["d", root.id],
    ],
    "c".repeat(64),
    25,
  );
  const profiles = projectProfiles([
    event("profile", 0, JSON.stringify({ display_name: "Bob" }), [], other),
  ]);
  const rows = projectTimeline(
    [root, removed, edit, reaction, deletion, summary],
    "channel-a",
    profiles,
    viewer,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, "after");
  assert.equal(rows[0].author.name, "Bob");
  assert.equal(rows[0].replyCount, 3);
  assert.deepEqual(
    rows[0].replyParticipants.map((profile) => profile.name),
    ["Bob"],
  );
  assert.deepEqual(rows[0].reactions, [
    { emoji: "🔥", count: 1, reactedByMe: true },
  ]);
});

test("projects a root and chronological thread replies", () => {
  const viewer = "a".repeat(64);
  const root = event("root", 9, "root", [["h", "channel-a"]], viewer, 20);
  const reply = event(
    "reply",
    9,
    "reply",
    [
      ["h", "channel-a"],
      ["e", root.id, "", "reply"],
    ],
    "b".repeat(64),
    21,
  );
  const thread = projectThread(
    [reply, root],
    "channel-a",
    root.id,
    new Map(),
    viewer,
  );
  assert.equal(thread.root?.content, "root");
  assert.deepEqual(
    thread.replies.map((row) => row.content),
    ["reply"],
  );
});

test("projects nested replies as Android-style child threads", () => {
  const viewer = "a".repeat(64);
  const root = event(
    "nested-root",
    9,
    "root",
    [["h", "channel-a"]],
    viewer,
    20,
  );
  const parent = event(
    "nested-parent",
    9,
    "parent",
    [
      ["h", "channel-a"],
      ["e", root.id, "", "reply"],
    ],
    "b".repeat(64),
    21,
  );
  const child = event(
    "nested-child",
    9,
    "child",
    [
      ["h", "channel-a"],
      ["e", root.id, "", "root"],
      ["e", parent.id, "", "reply"],
    ],
    viewer,
    22,
  );

  const thread = projectThread(
    [child, root, parent],
    "channel-a",
    root.id,
    new Map(),
    viewer,
  );
  assert.deepEqual(
    thread.replies.map((message) => [
      message.content,
      message.threadRootId,
      message.parentId,
      message.replyCount,
    ]),
    [["parent", root.id, root.id, 1]],
  );
  assert.deepEqual(
    thread.replies[0].replyParticipants.map((profile) => profile.pubkey),
    [viewer],
  );

  const nested = projectThread(
    [child, root, parent],
    "channel-a",
    parent.id,
    new Map(),
    viewer,
  );
  assert.equal(nested.outerRootId, root.id);
  assert.equal(nested.root?.content, "parent");
  assert.deepEqual(
    nested.replies.map((message) => [message.content, message.parentId]),
    [["child", parent.id]],
  );
});

test("raw relay replies stay out of the timeline and derive thread counts", () => {
  const viewer = "a".repeat(64);
  const root = event("root", 9, "root", [["h", "channel-a"]], viewer, 20);
  const reply = event(
    "reply",
    9,
    "reply",
    [
      ["h", "channel-a"],
      ["e", root.id, "", "reply"],
    ],
    "b".repeat(64),
    21,
  );
  const rows = projectTimeline([reply, root], "channel-a", new Map(), viewer);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, root.id);
  assert.equal(rows[0].replyCount, 1);
  assert.equal(rows[0].lastReplyAt, 21);
});

test("projects every channel root into a workspace thread index", () => {
  const viewer = "a".repeat(64);
  const other = "b".repeat(64);
  const channels = [
    {
      id: "channel-a",
      name: "alpha",
      description: "",
      type: "stream" as const,
      visibility: "public" as const,
      archived: false,
    },
    {
      id: "channel-b",
      name: "beta",
      description: "",
      type: "stream" as const,
      visibility: "public" as const,
      archived: false,
    },
  ];
  const first = event("first", 9, "first", [["h", "channel-a"]], viewer, 20);
  const second = event("second", 9, "second", [["h", "channel-b"]], other, 21);
  const reply = event(
    "reply",
    9,
    "reply",
    [
      ["h", "channel-a"],
      ["e", first.id, "", "reply"],
    ],
    other,
    22,
  );
  const threads = projectThreadIndex(
    [first, second, reply],
    channels,
    new Map(),
    viewer,
  );
  assert.deepEqual(
    threads.map((thread) => [
      thread.channel.id,
      thread.root.id,
      thread.root.replyCount,
      thread.activityAt,
    ]),
    [
      ["channel-a", first.id, 1, 22],
      ["channel-b", second.id, 0, 21],
    ],
  );
});

test("projects an http profile picture for avatar rendering", () => {
  const pubkey = "b".repeat(64);
  const profiles = projectProfiles([
    event(
      "profile-picture",
      0,
      JSON.stringify({
        display_name: "Picture Person",
        picture: "https://relay.example/media/avatar.png",
      }),
      [],
      pubkey,
    ),
  ]);
  assert.equal(
    profiles.get(pubkey)?.picture,
    "https://relay.example/media/avatar.png",
  );
});
