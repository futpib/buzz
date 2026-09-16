import assert from "node:assert/strict";
import test from "node:test";

import { projectInboxItems } from "./inbox-view";
import type { ChannelView, NostrEvent } from "./types";

function event(
  id: string,
  createdAt: number,
  tags: string[][],
  kind = 9,
): NostrEvent {
  return {
    id: id.padEnd(64, "0"),
    pubkey: "b".repeat(64),
    created_at: createdAt,
    kind,
    tags,
    content: id,
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

test("groups inbox activity by conversation and opens the visible branch", () => {
  const rootId = "a".repeat(64);
  const parentId = "d".repeat(64);
  const direct = event("direct", 10, [
    ["h", "allowed"],
    ["e", rootId, "", "reply"],
  ]);
  const nested = event("nested", 11, [
    ["h", "allowed"],
    ["e", rootId, "", "root"],
    ["e", parentId, "", "reply"],
  ]);
  const rows = projectInboxItems(
    [direct, nested, nested],
    [channel],
    new Map(),
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].conversationId, rootId);
  assert.equal(rows[0].id, nested.id);
  assert.equal(rows[0].threadId, parentId);
  assert.equal(rows[0].itemCount, 2);
  assert.deepEqual(rows[0].categories, ["mention", "thread"]);
});

test("keeps needs-action events and drops events from unauthorized channels", () => {
  const approval = event("approval", 20, [["p", "a".repeat(64)]], 46_010);
  const hidden = event("hidden", 21, [["h", "hidden"]]);
  const rows = projectInboxItems([hidden, approval], [channel], new Map());

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, approval.id);
  assert.deepEqual(rows[0].categories, ["needs_action"]);
  assert.equal(rows[0].channel, null);
  assert.equal(rows[0].threadId, null);
});
