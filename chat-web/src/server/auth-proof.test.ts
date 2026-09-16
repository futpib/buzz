import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent } from "nostr-tools";

import { validateAuthEvent } from "./auth-proof";
import type { NostrEvent } from "./types";

const relay = "wss://relay.example";
const challenge = "one-time-challenge";
const now = 1_700_000_000;
const secret = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

function proof(challengeValue = challenge, createdAt = now): NostrEvent {
  return finalizeEvent(
    {
      kind: 22242,
      created_at: createdAt,
      tags: [
        ["relay", relay],
        ["challenge", challengeValue],
      ],
      content: "",
    },
    secret,
  ) as NostrEvent;
}

test("accepts only a fresh proof bound to the issued relay challenge", () => {
  assert.doesNotThrow(() => validateAuthEvent(proof(), challenge, relay, now));
  assert.throws(
    () => validateAuthEvent(proof("different"), challenge, relay, now),
    /one-time challenge/,
  );
  assert.throws(
    () => validateAuthEvent(proof(challenge, now - 61), challenge, relay, now),
    /stale/,
  );
});
