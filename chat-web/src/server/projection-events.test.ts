import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANNEL_MESSAGE_KINDS,
  loadCompleteChannelProjection,
  loadProjectionAuxClosure,
  type RelayQuery,
} from "./projection-events";
import { projectTimeline } from "./projector";
import type { NostrEvent } from "./types";

function event(
  id: string,
  kind: number,
  content: string,
  tags: string[][],
  createdAt: number,
): NostrEvent {
  return {
    id: id.repeat(64).slice(0, 64),
    pubkey: "a".repeat(64),
    created_at: createdAt,
    kind,
    tags,
    content,
    sig: "b".repeat(128),
  };
}

test("complete thread-index history bakes reactions into its first projection", async () => {
  const channelId = "channel-a";
  const root = event("1", 9, "root", [["h", channelId]], 20);
  const reaction = event(
    "2",
    7,
    "🔥",
    [
      ["h", channelId],
      ["e", root.id],
    ],
    19,
  );
  const pages = [[root], []];
  const filters: Record<string, unknown>[] = [];
  const query: RelayQuery = async ([filter]) => {
    filters.push(filter);
    const kinds = filter.kinds as number[];
    if (kinds.includes(7)) return [reaction];
    if (filter["#e"]) return [];
    return pages.shift() ?? [];
  };

  const events = await loadCompleteChannelProjection(query, channelId, 1);
  const rows = projectTimeline(events, channelId, new Map(), root.pubkey);

  assert.deepEqual(rows[0].reactions, [
    { emoji: "🔥", count: 1, reactedByMe: true },
  ]);
  assert.equal(new Set<number>(CHANNEL_MESSAGE_KINDS).has(7), false);
  assert.equal(filters.length, 4);
  assert.deepEqual(filters[1], {
    kinds: [...CHANNEL_MESSAGE_KINDS],
    "#h": [channelId],
    limit: 1,
    until: root.created_at,
    before_id: root.id,
  });
  assert.deepEqual(filters[2], {
    kinds: [5, 7, 9005, 40003],
    "#h": [channelId],
    "#e": [root.id],
    limit: 5_000,
  });
});

test("targeted projection closure includes deletion of a reaction atomically", async () => {
  const channelId = "channel-a";
  const root = event("3", 9, "before", [["h", channelId]], 20);
  const reaction = event(
    "4",
    7,
    "👍",
    [
      ["h", channelId],
      ["e", root.id],
    ],
    21,
  );
  const edit = event(
    "5",
    40003,
    "after",
    [
      ["h", channelId],
      ["e", root.id],
    ],
    22,
  );
  const deletion = event(
    "6",
    5,
    "",
    [
      ["h", channelId],
      ["e", reaction.id],
    ],
    23,
  );
  const stored = [reaction, edit, deletion];
  const query: RelayQuery = async ([filter]) => {
    const kinds = new Set(filter.kinds as number[]);
    const targets = new Set(filter["#e"] as string[]);
    return stored.filter(
      (candidate) =>
        kinds.has(candidate.kind) &&
        candidate.tags.some(
          (tag) => tag[0] === "e" && targets.has(tag[1] ?? ""),
        ),
    );
  };

  const closure = await loadProjectionAuxClosure(query, channelId, [root.id]);
  const rows = projectTimeline(
    [root, ...closure],
    channelId,
    new Map(),
    root.pubkey,
  );

  assert.deepEqual(
    closure.map((candidate) => candidate.id),
    [reaction.id, edit.id, deletion.id],
  );
  assert.equal(rows[0].content, "after");
  assert.deepEqual(rows[0].reactions, []);
});
