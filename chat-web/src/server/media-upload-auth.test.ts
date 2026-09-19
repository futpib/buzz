import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent, getPublicKey } from "nostr-tools";

import type { NostrEvent } from "./types";
import { validateMediaUploadAuthorization } from "./media-upload-auth";

const secret = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const pubkey = getPublicKey(secret);
const now = 1_700_000_000;
const hash = "a".repeat(64);

function authorization(overrides: Partial<NostrEvent> = {}): string {
  const event = finalizeEvent(
    {
      kind: overrides.kind ?? 24_242,
      created_at: overrides.created_at ?? now,
      tags: overrides.tags ?? [
        ["t", "upload"],
        ["x", hash],
        ["expiration", String(now + 600)],
        ["server", "relay.example"],
      ],
      content: overrides.content ?? "Upload file",
    },
    secret,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64url")}`;
}

test("accepts a fresh hash-bound upload proof from the login identity", () => {
  const event = validateMediaUploadAuthorization(
    authorization(),
    pubkey,
    hash,
    "relay.example",
    now,
  );
  assert.equal(event.pubkey, pubkey);
});

test("rejects cross-hash, cross-server, duplicate, and cross-identity proofs", () => {
  assert.throws(
    () =>
      validateMediaUploadAuthorization(
        authorization(),
        pubkey,
        "b".repeat(64),
        "relay.example",
        now,
      ),
    /invalid/,
  );
  assert.throws(
    () =>
      validateMediaUploadAuthorization(
        authorization(),
        pubkey,
        hash,
        "other.example",
        now,
      ),
    /invalid/,
  );
  assert.throws(
    () =>
      validateMediaUploadAuthorization(
        authorization({
          tags: [
            ["t", "upload"],
            ["t", "get"],
            ["x", hash],
            ["expiration", String(now + 600)],
            ["server", "relay.example"],
          ],
        }),
        pubkey,
        hash,
        "relay.example",
        now,
      ),
    /invalid/,
  );
  assert.throws(
    () =>
      validateMediaUploadAuthorization(
        authorization(),
        "f".repeat(64),
        hash,
        "relay.example",
        now,
      ),
    /invalid/,
  );
});
