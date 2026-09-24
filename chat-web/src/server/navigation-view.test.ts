import assert from "node:assert/strict";
import test from "node:test";

import { projectNavigationCandidates } from "./navigation-view";
import type { ChannelView, NostrEvent } from "./types";

const viewer = "a".repeat(64);
const other = "b".repeat(64);
const channel: ChannelView = {
  id: "channel-a",
  name: "general",
  description: "",
  type: "stream",
  visibility: "public",
  archived: false,
};

function event(
  id: string,
  kind: number,
  tags: string[][],
  createdAt: number,
  pubkey = other,
): NostrEvent {
  return {
    id,
    kind,
    tags,
    created_at: createdAt,
    pubkey,
    content: id,
    sig: "c".repeat(128),
  };
}

test("projects permission-scoped unread candidates and thread semantics", () => {
  const root = event("1".repeat(64), 9, [["h", channel.id]], 10);
  const reply = event(
    "2".repeat(64),
    9,
    [
      ["h", channel.id],
      ["e", root.id, "", "reply"],
      ["p", viewer],
    ],
    11,
  );
  const hidden = event("3".repeat(64), 9, [["h", "hidden"]], 12);
  const rows = projectNavigationCandidates(
    [root, reply, hidden],
    [channel],
    new Map(),
    viewer,
  );
  assert.deepEqual(
    rows.map((row) => [row.id, row.rootId, row.parentId, row.highPriority]),
    [
      [root.id, null, null, false],
      [reply.id, root.id, root.id, true],
    ],
  );
});

test("drops deleted and archived candidates", () => {
  const message = event("4".repeat(64), 9, [["h", channel.id]], 10);
  const deletion = event(
    "5".repeat(64),
    5,
    [
      ["h", channel.id],
      ["e", message.id],
    ],
    11,
    viewer,
  );
  assert.deepEqual(
    projectNavigationCandidates(
      [message, deletion],
      [channel],
      new Map(),
      viewer,
    ),
    [],
  );
  assert.deepEqual(
    projectNavigationCandidates(
      [message],
      [{ ...channel, archived: true }],
      new Map(),
      viewer,
    ),
    [],
  );
});
