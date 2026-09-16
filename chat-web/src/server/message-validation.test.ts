import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent } from "nostr-tools";

import { validateMessageEvent } from "./message-validation";
import type { NostrEvent } from "./types";

const now = 1_700_000_000;
const secret = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const channel = "90db6dbb-a9f1-4c04-a4bb-eb5d2beec82b";

function message(kind = 9): NostrEvent {
  return finalizeEvent(
    {
      kind,
      created_at: now,
      tags: [["h", channel]],
      content: "hello",
    },
    secret,
  ) as NostrEvent;
}

function reply(tags: string[][]): NostrEvent {
  return finalizeEvent(
    {
      kind: 9,
      created_at: now,
      tags: [["h", channel], ...tags],
      content: "reply",
    },
    secret,
  ) as NostrEvent;
}

test("accepts only fresh signed message events from the login identity", () => {
  const event = message();
  assert.doesNotThrow(() => validateMessageEvent(event.pubkey, event, now));
  assert.throws(
    () => validateMessageEvent("f".repeat(64), event, now),
    /does not match/,
  );
  assert.throws(
    () => validateMessageEvent(message(5).pubkey, message(5), now),
    /kind is not allowed/,
  );
  assert.throws(
    () => validateMessageEvent(event.pubkey, event, now + 61),
    /stale/,
  );
});

test("accepts canonical direct and nested replies but rejects ambiguous markers", () => {
  const root = "a".repeat(64);
  const parent = "b".repeat(64);
  for (const event of [
    reply([["e", root, "", "reply"]]),
    reply([
      ["e", root, "", "root"],
      ["e", parent, "", "reply"],
    ]),
  ]) {
    assert.doesNotThrow(() => validateMessageEvent(event.pubkey, event, now));
  }

  const ambiguous = reply([
    ["e", root, "", "reply"],
    ["e", parent, "", "reply"],
  ]);
  assert.throws(
    () => validateMessageEvent(ambiguous.pubkey, ambiguous, now),
    /NIP-10/,
  );
});
