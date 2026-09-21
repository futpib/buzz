import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent, nip19 } from "nostr-tools";

import {
  makeDeletionEvent,
  makeMessageEditEvent,
  makeReactionEvent,
} from "@/client/identity";
import { validateMessageActionEvent } from "./message-action-validation";

const secret = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const nsec = nip19.nsecEncode(secret);
const credential = { nsec, authTag: null };
const channelId = "90db6dbb-a9f1-4c04-a4bb-eb5d2beec82b";
const targetId = "a".repeat(64);
const now = 1_700_000_000;

test("accepts only fresh, session-bound reaction, edit, and deletion events", () => {
  const events = [
    makeReactionEvent(credential, targetId, "👍", now),
    makeMessageEditEvent(
      credential,
      { channelId, targetId, content: "updated" },
      now,
    ),
    makeDeletionEvent(credential, { channelId, targetId }, now),
    makeDeletionEvent(credential, { targetId }, now),
  ];

  for (const event of events) {
    assert.doesNotThrow(() =>
      validateMessageActionEvent(event.pubkey, event, now),
    );
    assert.throws(
      () => validateMessageActionEvent("b".repeat(64), event, now),
      /signer does not match/,
    );
    assert.throws(
      () => validateMessageActionEvent(event.pubkey, event, now + 61),
      /timestamp is stale/,
    );
  }
});

test("rejects a valid signature whose action envelope is non-canonical", () => {
  const reactionWithChannel = finalizeEvent(
    {
      kind: 7,
      created_at: now,
      content: "👍",
      tags: [
        ["h", channelId],
        ["e", targetId],
      ],
    },
    secret,
  );
  assert.throws(
    () =>
      validateMessageActionEvent(
        reactionWithChannel.pubkey,
        reactionWithChannel,
        now,
      ),
    /canonical target-only shape/,
  );
});
