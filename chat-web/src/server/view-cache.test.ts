import assert from "node:assert/strict";
import test from "node:test";

import { ViewCache } from "./view-cache";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

test("coalesces misses and serves fresh projected views", async () => {
  let now = 1_000;
  let loads = 0;
  const pending = deferred<string>();
  const cache = new ViewCache<string>({
    maxEntries: 4,
    staleAfterMs: 100,
    now: () => now,
  });
  const load = () => {
    loads += 1;
    return pending.promise;
  };

  const first = cache.get("session:channel", load);
  const second = cache.get("session:channel", load);
  assert.equal(loads, 1);
  pending.resolve("projected");
  assert.equal((await first).state, "miss");
  assert.equal((await second).value, "projected");

  now += 50;
  assert.deepEqual(await cache.get("session:channel", load), {
    value: "projected",
    state: "fresh",
    ageMs: 50,
  });
  assert.equal(loads, 1);
});

test("returns stale immediately, refreshes once, and retries failures", async () => {
  let now = 1_000;
  const errors: unknown[] = [];
  const cache = new ViewCache<string>({
    maxEntries: 4,
    staleAfterMs: 100,
    now: () => now,
    onBackgroundError: (error) => errors.push(error),
  });
  cache.set("session:threads", "old");
  now += 101;

  const failed = deferred<string>();
  const stale = await cache.get("session:threads", () => failed.promise);
  assert.equal(stale.state, "stale");
  assert.equal(stale.value, "old");
  failed.reject(new Error("relay unavailable"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);

  const replacement = deferred<string>();
  assert.equal(
    (await cache.get("session:threads", () => replacement.promise)).value,
    "old",
  );
  replacement.resolve("new");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    (await cache.get("session:threads", async () => "unused")).value,
    "new",
  );
});

test("a stale in-flight generation cannot overwrite an invalidated view", async () => {
  let now = 1_000;
  const cache = new ViewCache<string>({
    maxEntries: 4,
    staleAfterMs: 10,
    now: () => now,
  });
  cache.set("session:channel", "old");
  now += 11;
  const obsolete = deferred<string>();
  assert.equal(
    (await cache.get("session:channel", () => obsolete.promise)).state,
    "stale",
  );
  cache.markStale((key) => key === "session:channel");
  obsolete.resolve("obsolete");
  await new Promise((resolve) => setImmediate(resolve));

  const current = await cache.refresh("session:channel", async () => "current");
  assert.equal(current.value, "current");
  assert.equal(current.state, "refreshed");
});

test("a refresh waiter advances past an invalidated in-flight generation", async () => {
  let now = 1_000;
  let loads = 0;
  const cache = new ViewCache<string>({
    maxEntries: 4,
    staleAfterMs: 10,
    now: () => now,
  });
  cache.set("session:channel", "old");
  now += 11;
  const obsolete = deferred<string>();
  assert.equal(
    (
      await cache.get("session:channel", () => {
        loads += 1;
        return obsolete.promise;
      })
    ).state,
    "stale",
  );
  cache.markStale((key) => key === "session:channel");
  const current = cache.refresh("session:channel", async () => {
    loads += 1;
    return "current";
  });

  obsolete.resolve("obsolete");
  assert.deepEqual(await current, {
    value: "current",
    state: "refreshed",
    ageMs: 0,
  });
  assert.equal(loads, 2);
});

test("bounds idle entries by least-recent access", async () => {
  let now = 1;
  const cache = new ViewCache<string>({
    maxEntries: 2,
    staleAfterMs: 1_000,
    now: () => now,
  });
  cache.set("a", "A");
  now += 1;
  cache.set("b", "B");
  now += 1;
  await cache.get("a", async () => "not used");
  now += 1;
  cache.set("c", "C");

  let loads = 0;
  const loaded = await cache.get("b", async () => {
    loads += 1;
    return "B2";
  });
  assert.equal(loaded.state, "miss");
  assert.equal(loaded.value, "B2");
  assert.equal(loads, 1);
});
