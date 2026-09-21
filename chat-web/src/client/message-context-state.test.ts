import assert from "node:assert/strict";
import test from "node:test";

import {
  isMessageForcedUnread,
  isThreadFollowed,
  setMessageForcedUnread,
  setThreadFollowed,
} from "./message-context-state";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

test("forced unread is tab-local while thread follows persist by identity", () => {
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

  const alice = "a".repeat(64);
  const bob = "b".repeat(64);
  assert.equal(setMessageForcedUnread(alice, "message", true), true);
  assert.equal(isMessageForcedUnread(alice, "message"), true);
  assert.equal(isMessageForcedUnread(bob, "message"), false);
  assert.equal(setMessageForcedUnread(alice, "message", false), false);
  assert.equal(isMessageForcedUnread(alice, "message"), false);

  assert.equal(setThreadFollowed(alice, "thread", true), true);
  assert.equal(isThreadFollowed(alice, "thread"), true);
  assert.equal(isThreadFollowed(bob, "thread"), false);
  assert.equal(setThreadFollowed(alice, "thread", false), false);
  assert.equal(isThreadFollowed(alice, "thread"), false);
});
