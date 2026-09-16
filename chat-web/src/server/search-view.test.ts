import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_SEARCH_QUERY_LENGTH,
  normalizeSearchQuery,
  projectSearchResults,
} from "./search-view";
import type { ChannelView, NostrEvent, ProfileView } from "./types";

function event(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "a".repeat(64),
    pubkey: "b".repeat(64),
    created_at: 1_700_000_000,
    kind: 9,
    tags: [["h", "allowed"]],
    content: "search result",
    sig: "c".repeat(128),
    ...overrides,
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

const profile: ProfileView = {
  pubkey: "b".repeat(64),
  name: "Bee",
  picture: null,
  initials: "BE",
  color: "purple",
};

test("normalizes and bounds workspace search text", () => {
  assert.equal(normalizeSearchQuery("  incident review  "), "incident review");
  assert.equal(normalizeSearchQuery("   "), "");
  assert.throws(
    () => normalizeSearchQuery("x".repeat(MAX_SEARCH_QUERY_LENGTH + 1)),
    /256 characters or fewer/,
  );
});

test("projects only results from the viewers projected channel roster", () => {
  const viewer = "d".repeat(64);
  const hidden = event({
    id: "e".repeat(64),
    tags: [["h", "hidden"]],
    content: "must not leak",
  });
  const results = projectSearchResults(
    [event(), hidden],
    [channel],
    new Map([[profile.pubkey, profile]]),
    viewer,
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].channelId, "allowed");
  assert.equal(results[0].channelName, "general");
  assert.equal(results[0].author.name, "Bee");
  assert.equal(results[0].isOwn, false);
});

test("links search hits to the visible branch that contains them", () => {
  const root = event();
  const direct = event({
    id: "f".repeat(64),
    tags: [
      ["h", "allowed"],
      ["e", root.id, "", "reply"],
    ],
  });
  const nested = event({
    id: "e".repeat(64),
    tags: [
      ["h", "allowed"],
      ["e", root.id, "", "root"],
      ["e", direct.id, "", "reply"],
    ],
  });
  const results = projectSearchResults(
    [nested, direct, root, direct],
    [channel],
    new Map(),
    root.pubkey,
  );
  assert.deepEqual(
    results.map((result) => [result.id, result.threadId, result.isOwn]),
    [
      [nested.id, direct.id, true],
      [direct.id, root.id, true],
      [root.id, root.id, true],
    ],
  );
});
