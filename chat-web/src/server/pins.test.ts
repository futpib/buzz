import assert from "node:assert/strict";
import test from "node:test";
import {
  includePinnedReplies,
  loadChannelPins,
  projectPins,
} from "@/server/pins";
import type { NostrEvent } from "@/server/types";
const channel = "channel";
const viewer = "a".repeat(64);
const other = "b".repeat(64);
const event = (
  id: string,
  kind: number,
  tags: string[][] = [],
  pubkey = viewer,
): NostrEvent => ({
  id: id.repeat(64),
  kind,
  tags,
  pubkey,
  created_at: 1,
  content: kind === 9 ? "old message" : "",
  sig: "",
});
const root = event("1", 9, [["h", channel]]);
const nested = event("2", 9, [
  ["h", channel],
  ["e", root.id, "", "root"],
  ["e", "3".repeat(64), "", "reply"],
]);
const pin = event("4", 40004, [
  ["h", channel],
  ["e", nested.id],
]);

test("pins resolve nested branches, retain other members' pins, and respect deletions", () => {
  const otherPin = { ...pin, id: "5".repeat(64), pubkey: other };
  const events = [root, nested, pin, otherPin];
  const projected = projectPins(events, channel, viewer);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].threadId, "3".repeat(64));
  assert.deepEqual(projected[0].ownPinIds, [pin.id]);
  assert.equal(
    projectPins([...events, event("6", 5, [["e", pin.id]])], channel, viewer)[0]
      .ownPinIds.length,
    0,
  );
  assert.equal(
    projectPins(
      [...events, event("6", 9005, [["e", nested.id]])],
      channel,
      viewer,
    ).length,
    0,
  );
  assert.equal(
    projectPins(
      [{ ...nested, tags: [["h", "elsewhere"]] }, pin],
      channel,
      viewer,
    ).length,
    0,
  );
});

test("pins fetch old messages outside the timeline and their edit closure", async () => {
  const queries: unknown[] = [];
  const result = await loadChannelPins(
    async (filters) => {
      queries.push(filters);
      const f = filters[0];
      if ((f.kinds as number[] | undefined)?.includes(40004)) return [pin];
      if (f.ids) return [nested];
      if ((f.kinds as number[] | undefined)?.includes(40003))
        return [
          {
            ...event("7", 40003, [
              ["h", channel],
              ["e", nested.id],
            ]),
            content: "edited pin",
            created_at: 2,
          },
        ];
      return [];
    },
    channel,
    viewer,
  );
  assert.equal(result[0].message.content, "edited pin");
  assert.ok(queries.length >= 3);
});

test("pinned replies outside the recent thread window remain reachable only in their containing branch", () => {
  const pins = projectPins([nested, pin], channel, viewer);
  const thread = {
    rootId: "3".repeat(64),
    outerRootId: root.id,
    root: null,
    replies: [],
  };
  assert.equal(includePinnedReplies(thread, pins).replies[0].id, nested.id);
  assert.equal(
    includePinnedReplies({ ...thread, rootId: root.id }, pins).replies.length,
    0,
  );
  const filled = includePinnedReplies(thread, pins);
  assert.equal(includePinnedReplies(filled, pins).replies.length, 1);
});
