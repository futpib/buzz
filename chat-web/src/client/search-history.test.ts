import assert from "node:assert/strict";
import test from "node:test";

import {
  clearRecentSearches,
  loadRecentSearches,
  MAX_RECENT_SEARCHES,
  rememberRecentSearch,
  removeRecentSearch,
} from "./search-history";

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

test("recent searches are ordered, deduplicated, trimmed, and bounded", () => {
  const storage = new MemoryStorage();
  const viewer = "A".repeat(64);
  for (let index = 0; index < MAX_RECENT_SEARCHES + 3; index += 1) {
    rememberRecentSearch(viewer, ` query ${index} `, storage);
  }
  rememberRecentSearch(viewer, "QUERY 7", storage);

  const searches = loadRecentSearches(viewer, storage);
  assert.equal(searches.length, MAX_RECENT_SEARCHES);
  assert.deepEqual(searches.slice(0, 3), ["QUERY 7", "query 10", "query 9"]);
  assert.equal(searches.includes("query 0"), false);
});

test("recent searches are isolated by signed-in identity", () => {
  const storage = new MemoryStorage();
  const viewerA = "a".repeat(64);
  const viewerB = "b".repeat(64);
  rememberRecentSearch(viewerA, "alpha", storage);
  rememberRecentSearch(viewerB, "beta", storage);

  assert.deepEqual(loadRecentSearches(viewerA, storage), ["alpha"]);
  assert.deepEqual(loadRecentSearches(viewerB, storage), ["beta"]);
});

test("recent searches support per-entry removal and clear all", () => {
  const storage = new MemoryStorage();
  const viewer = "c".repeat(64);
  rememberRecentSearch(viewer, "first", storage);
  rememberRecentSearch(viewer, "second", storage);

  assert.deepEqual(removeRecentSearch(viewer, "FIRST", storage), ["second"]);
  assert.deepEqual(clearRecentSearches(viewer, storage), []);
  assert.deepEqual(loadRecentSearches(viewer, storage), []);
  assert.equal(storage.length, 0);
});

test("invalid or unavailable browser storage does not break search", () => {
  const storage = new MemoryStorage();
  storage.setItem("buzz.search-history.v1.viewer", "not-json");
  assert.deepEqual(loadRecentSearches("viewer", storage), []);

  const blocked = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
    removeItem() {
      throw new Error("blocked");
    },
  } as unknown as Storage;
  assert.deepEqual(rememberRecentSearch("viewer", "safe", blocked), ["safe"]);
  assert.deepEqual(loadRecentSearches("viewer", blocked), []);
});
