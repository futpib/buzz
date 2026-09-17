import assert from "node:assert/strict";
import test from "node:test";

import { finalizeEvent, generateSecretKey } from "nostr-tools";

import { EventVerificationCache } from "./event-verification";
import type { NostrEvent } from "./types";

function signed(content: string): NostrEvent {
  return finalizeEvent(
    { kind: 9, created_at: 1, tags: [], content },
    generateSecretKey(),
  ) as NostrEvent;
}

test("memoized verification still rejects changed event content", () => {
  const cache = new EventVerificationCache(2);
  const event = signed("valid");

  assert.equal(cache.accepts(event), true);
  assert.equal(cache.accepts({ ...event }), true);
  assert.equal(cache.accepts({ ...event, content: "tampered" }), false);
  assert.equal(cache.size, 1);
});

test("verification memo is bounded by least-recent use", () => {
  const cache = new EventVerificationCache(2);
  const first = signed("first");
  const second = signed("second");
  const third = signed("third");

  assert.equal(cache.accepts(first), true);
  assert.equal(cache.accepts(second), true);
  assert.equal(cache.accepts({ ...first }), true);
  assert.equal(cache.accepts(third), true);
  assert.equal(cache.size, 2);
  assert.equal(cache.accepts({ ...second, content: "changed" }), false);
});
