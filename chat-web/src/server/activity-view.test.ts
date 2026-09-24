import assert from "node:assert/strict";
import test from "node:test";

import { projectActivityItems } from "./activity-view";
import type { ChannelView, NostrEvent, ProfileView } from "./types";

function event({
  id,
  kind = 9,
  pubkey = "b".repeat(64),
  createdAt,
  tags,
}: {
  id: string;
  kind?: number;
  pubkey?: string;
  createdAt: number;
  tags: string[][];
}): NostrEvent {
  return {
    id: id.padEnd(64, "0"),
    pubkey,
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

test("groups activity by conversation and opens the latest visible branch", () => {
  const rootId = "a".repeat(64);
  const parentId = "d".repeat(64);
  const direct = event({
    id: "direct",
    createdAt: 10,
    tags: [
      ["h", "allowed"],
      ["e", rootId, "", "reply"],
    ],
  });
  const nested = event({
    id: "nested",
    createdAt: 11,
    tags: [
      ["h", "allowed"],
      ["e", rootId, "", "root"],
      ["e", parentId, "", "reply"],
    ],
  });

  const rows = projectActivityItems(
    [direct, nested, nested],
    [channel],
    new Map(),
    "f".repeat(64),
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].conversationId, rootId);
  assert.equal(rows[0].id, nested.id);
  assert.equal(rows[0].threadId, parentId);
  assert.equal(rows[0].itemCount, 2);
  assert.equal(rows[0].kind, "message");
});

test("keeps supported global agent work and drops unauthorized channel events", () => {
  const viewer = "f".repeat(64);
  const profile: ProfileView = {
    pubkey: viewer,
    name: "Futpib",
    picture: null,
    initials: "FU",
    color: "#fff",
  };
  const job = event({
    id: "job",
    kind: 43_004,
    pubkey: viewer,
    createdAt: 20,
    tags: [],
  });
  const hidden = event({
    id: "hidden",
    createdAt: 21,
    tags: [["h", "hidden"]],
  });
  const unsupported = event({
    id: "reaction",
    kind: 7,
    createdAt: 22,
    tags: [["h", "allowed"]],
  });

  const rows = projectActivityItems(
    [hidden, unsupported, job],
    [channel],
    new Map([[viewer, profile]]),
    viewer,
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, job.id);
  assert.equal(rows[0].kind, "job_result");
  assert.equal(rows[0].channel, null);
  assert.equal(rows[0].threadId, null);
  assert.equal(rows[0].author.name, "Futpib");
  assert.equal(rows[0].isOwn, true);
});
