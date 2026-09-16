import assert from "node:assert/strict";
import test from "node:test";
import { verifyEvent, nip19 } from "nostr-tools";

import { makeAuthEvent, makeMessageEvent } from "./identity";

const secret = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const nsec = nip19.nsecEncode(secret);
const credential = {
  nsec,
  authTag: ["auth", "a".repeat(64), "", "b".repeat(128)],
};

test("browser signing returns only public signed events", () => {
  const auth = makeAuthEvent(
    credential,
    "one-time-challenge",
    "wss://relay.example",
    1_700_000_000,
  );
  const message = makeMessageEvent(credential, {
    channelId: "90db6dbb-a9f1-4c04-a4bb-eb5d2beec82b",
    content: "hello",
  });

  assert.equal(verifyEvent(auth), true);
  assert.equal(verifyEvent(message), true);
  assert.equal(JSON.stringify(auth).includes(nsec), false);
  assert.equal(JSON.stringify(message).includes(nsec), false);
  assert.deepEqual(auth.tags.at(-1), credential.authTag);
  assert.deepEqual(message.tags.at(-1), credential.authTag);
});
