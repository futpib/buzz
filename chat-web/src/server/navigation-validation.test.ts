import assert from "node:assert/strict";
import test from "node:test";

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";

import {
  isAllowedNavigationDTag,
  validateNavigationAppDataEvent,
} from "./navigation-validation";

test("allows only the interoperable navigation app-data coordinates", () => {
  assert.equal(isAllowedNavigationDTag("channel-stars"), true);
  assert.equal(isAllowedNavigationDTag("read-state:web-client"), true);
  assert.equal(isAllowedNavigationDTag("read-state:"), false);
  assert.equal(isAllowedNavigationDTag("other"), false);
  assert.equal(isAllowedNavigationDTag(`read-state:${"x".repeat(65)}`), false);
});

test("validates a signed encrypted navigation event", () => {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  const event = finalizeEvent(
    {
      kind: 30_078,
      created_at: 100,
      tags: [
        ["d", "channel-mutes"],
        ["t", "channel-mutes"],
      ],
      content: "ciphertext",
    },
    secret,
  );
  assert.doesNotThrow(() => validateNavigationAppDataEvent(pubkey, event, 100));
  assert.throws(
    () =>
      validateNavigationAppDataEvent(
        pubkey,
        { ...event, tags: [["d", "channel-mutes"]] },
        100,
      ),
    /topic/,
  );
});
