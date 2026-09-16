import assert from "node:assert/strict";
import test from "node:test";
import { verifyEvent, nip19 } from "nostr-tools";

import {
  forgetCredential,
  encodeNostrAuthorization,
  loadPersistentCredential,
  makeAuthEvent,
  makeMediaGetAuthEvent,
  makeMessageEvent,
  storeCredential,
} from "./identity";

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

test("nested browser replies carry canonical root and parent markers", () => {
  const rootId = "a".repeat(64);
  const parentId = "b".repeat(64);
  const message = makeMessageEvent(credential, {
    channelId: "90db6dbb-a9f1-4c04-a4bb-eb5d2beec82b",
    content: "nested",
    rootId,
    parentId,
  });

  assert.equal(verifyEvent(message), true);
  assert.deepEqual(message.tags.slice(0, 3), [
    ["h", "90db6dbb-a9f1-4c04-a4bb-eb5d2beec82b"],
    ["e", rootId, "", "root"],
    ["e", parentId, "", "reply"],
  ]);
});

test("browser media auth is public, scoped, fresh, and key-free", () => {
  const createdAt = 1_700_000_000;
  const event = makeMediaGetAuthEvent(
    credential,
    "Relay.Example:443",
    createdAt,
  );
  assert.equal(verifyEvent(event), true);
  assert.equal(event.kind, 24_242);
  assert.deepEqual(event.tags, [
    ["t", "get"],
    ["expiration", String(createdAt + 600)],
    ["server", "relay.example:443"],
  ]);
  assert.equal(JSON.stringify(event).includes(credential.nsec), false);
  const authorization = encodeNostrAuthorization(event);
  assert.match(authorization, /^Nostr [A-Za-z0-9_-]+$/);
  const decoded = JSON.parse(
    Buffer.from(authorization.slice(6), "base64url").toString("utf8"),
  );
  assert.equal(decoded.id, event.id);
});

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test("browser identity survives through the production local fallback", async () => {
  const session = new MemoryStorage();
  const local = new MemoryStorage();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: session,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: local,
  });

  await storeCredential(credential);
  assert.match(session.getItem("buzz.identity.v1") ?? "", /nsec1/);
  assert.match(local.getItem("buzz.identity.persistent.v1") ?? "", /nsec1/);

  session.clear();
  assert.deepEqual(await loadPersistentCredential(), credential);
  assert.match(session.getItem("buzz.identity.v1") ?? "", /nsec1/);

  await forgetCredential();
  assert.equal(session.length, 0);
  assert.equal(local.length, 0);
  Reflect.deleteProperty(globalThis, "sessionStorage");
  Reflect.deleteProperty(globalThis, "localStorage");
});
