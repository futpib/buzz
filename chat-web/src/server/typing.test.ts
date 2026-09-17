import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent, getPublicKey } from "nostr-tools";

import { projectTypingIndicator, validateTypingEvent } from "./typing";

const secret = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const pubkey = getPublicKey(secret);
const channelId = "90db6dbb-a9f1-4c04-a4bb-eb5d2beec82b";
const rootId = "a".repeat(64);
const threadHeadId = "b".repeat(64);

function typingEvent(
  tags: string[][] = [
    ["h", channelId],
    ["e", rootId, "", "root"],
    ["e", threadHeadId, "", "reply"],
  ],
  createdAt = 1_700_000_000,
) {
  return finalizeEvent(
    { kind: 20_002, created_at: createdAt, content: "", tags },
    secret,
  );
}

test("accepts and projects a fresh signed thread typing indicator", () => {
  const event = typingEvent();
  validateTypingEvent(pubkey, event, event.created_at);
  assert.deepEqual(
    projectTypingIndicator(event, channelId, event.created_at * 1_000 + 100),
    {
      pubkey,
      threadHeadId,
      createdAt: event.created_at,
    },
  );
});

test("rejects malformed, stale, and cross-session typing indicators", () => {
  const event = typingEvent();
  assert.throws(
    () => validateTypingEvent("c".repeat(64), event, event.created_at),
    /does not match/,
  );
  assert.throws(
    () => validateTypingEvent(pubkey, event, event.created_at + 61),
    /stale/,
  );
  assert.throws(
    () =>
      validateTypingEvent(
        pubkey,
        typingEvent([
          ["h", channelId],
          ["e", rootId],
        ]),
        1_700_000_000,
      ),
    /thread markers/,
  );
  assert.equal(
    projectTypingIndicator(event, channelId, event.created_at * 1_000 + 8_001),
    null,
  );
});
