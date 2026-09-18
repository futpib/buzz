import assert from "node:assert/strict";
import test from "node:test";

import { projectSentItems } from "./sent-view";
import type { ChannelView, NostrEvent } from "./types";

const viewer = "a".repeat(64);
const other = "b".repeat(64);

function event(
  id: string,
  kind: number,
  content: string,
  tags: string[][],
  pubkey = viewer,
  createdAt = 10,
): NostrEvent {
  return {
    id: id.padEnd(64, "0"),
    pubkey,
    created_at: createdAt,
    kind,
    tags,
    content,
    sig: "c".repeat(128),
  };
}

const channel: ChannelView = {
  id: "allowed",
  name: "general",
  description: "",
  type: "stream",
  visibility: "private",
  archived: false,
};

test("projects authored roots and replies with exact visible-branch targets", () => {
  const root = event("root", 9, "root", [["h", "allowed"]], viewer, 10);
  const direct = event(
    "direct",
    9,
    "direct",
    [
      ["h", "allowed"],
      ["e", root.id, "", "reply"],
    ],
    viewer,
    11,
  );
  const nested = event(
    "nested",
    9,
    "nested",
    [
      ["h", "allowed"],
      ["e", root.id, "", "root"],
      ["e", direct.id, "", "reply"],
    ],
    viewer,
    12,
  );
  const rows = projectSentItems(
    [root, direct, nested],
    [channel],
    new Map(),
    viewer,
  );

  assert.deepEqual(
    rows.map((row) => [row.id, row.threadId]),
    [
      [nested.id, direct.id],
      [direct.id, root.id],
      [root.id, root.id],
    ],
  );
});

test("folds sent decorations and excludes deleted, foreign, and hidden rows", () => {
  const kept = event("kept", 9, "before", [["h", "allowed"]], viewer, 10);
  const removed = event(
    "removed",
    9,
    "removed",
    [["h", "allowed"]],
    viewer,
    11,
  );
  const edit = event(
    "edit",
    40_003,
    "after",
    [
      ["h", "allowed"],
      ["e", kept.id],
    ],
    viewer,
    12,
  );
  const reaction = event(
    "reaction",
    7,
    "🔥",
    [
      ["h", "allowed"],
      ["e", kept.id],
    ],
    other,
    13,
  );
  const deletion = event(
    "deletion",
    5,
    "",
    [
      ["h", "allowed"],
      ["e", removed.id],
    ],
    viewer,
    14,
  );
  const foreign = event("foreign", 9, "foreign", [["h", "allowed"]], other, 15);
  const hidden = event("hidden", 9, "hidden", [["h", "hidden"]], viewer, 16);
  const rows = projectSentItems(
    [kept, removed, edit, reaction, deletion, foreign, hidden],
    [channel],
    new Map(),
    viewer,
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, kept.id);
  assert.equal(rows[0].message.content, "after");
  assert.equal(rows[0].message.editedAt, 12);
  assert.deepEqual(rows[0].message.reactions, [
    { emoji: "🔥", count: 1, reactedByMe: false },
  ]);
});
