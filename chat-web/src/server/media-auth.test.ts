import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent, getPublicKey } from "nostr-tools";

import type { NostrEvent } from "./types";
import { relayMediaTarget, validateMediaAuthorization } from "./media-auth";

const secret = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const pubkey = getPublicKey(secret);
const now = 1_700_000_000;
const target = new URL(`https://relay.example/media/${"a".repeat(64)}.png`);

function authorization(overrides: Partial<NostrEvent> = {}): string {
  const event = finalizeEvent(
    {
      kind: overrides.kind ?? 24_242,
      created_at: overrides.created_at ?? now,
      tags: overrides.tags ?? [
        ["t", "get"],
        ["expiration", String(now + 600)],
        ["server", "relay.example"],
      ],
      content: overrides.content ?? "Get buzz-media",
    },
    secret,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64url")}`;
}

test("accepts a fresh relay-bound media proof from the login identity", () => {
  const event = validateMediaAuthorization(
    authorization(),
    pubkey,
    target,
    now,
  );
  assert.equal(event.pubkey, pubkey);
});

test("rejects stale, cross-server, duplicate, and cross-identity proofs", () => {
  assert.throws(
    () =>
      validateMediaAuthorization(
        authorization({ created_at: now - 601 }),
        pubkey,
        target,
        now,
      ),
    /invalid/,
  );
  assert.throws(
    () =>
      validateMediaAuthorization(
        authorization({
          tags: [
            ["t", "get"],
            ["expiration", String(now + 600)],
            ["server", "other.example"],
          ],
        }),
        pubkey,
        target,
        now,
      ),
    /invalid/,
  );
  assert.throws(
    () =>
      validateMediaAuthorization(
        authorization({
          tags: [
            ["t", "get"],
            ["t", "upload"],
            ["expiration", String(now + 600)],
            ["server", "relay.example"],
          ],
        }),
        pubkey,
        target,
        now,
      ),
    /invalid/,
  );
  assert.throws(
    () =>
      validateMediaAuthorization(authorization(), "f".repeat(64), target, now),
    /invalid/,
  );
});

test("allows only hash-addressed media on the configured relay origin", () => {
  assert.equal(
    relayMediaTarget("https://relay.example", target.href).href,
    target.href,
  );
  for (const hostile of [
    `https://evil.example/media/${"a".repeat(64)}.png`,
    "https://relay.example/admin",
    `https://relay.example/media/${"a".repeat(64)}.png?next=evil`,
    `https://relay.example/media/${"a".repeat(64)}.svg/../png`,
  ]) {
    assert.throws(
      () => relayMediaTarget("https://relay.example", hostile),
      /not a relay blob URL/,
      hostile,
    );
  }
});
