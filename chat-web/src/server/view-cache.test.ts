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

  now += 1_000;
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

test("a burst of stale readers logs one failure and backs off without losing cached data", async () => {
  let now = 100;
  let loads = 0;
  let errors = 0;
  const cache = new ViewCache<string>({
    maxEntries: 4,
    staleAfterMs: 10,
    now: () => now,
    onBackgroundError: () => errors++,
  });
  cache.set("view", "saved");
  now += 11;
  const pending = deferred<string>();
  const load = () => {
    loads++;
    return pending.promise;
  };
  const reads = await Promise.all(
    Array.from({ length: 20 }, () => cache.get("view", load)),
  );
  assert.ok(reads.every((result) => result.value === "saved"));
  assert.equal(loads, 1);
  pending.reject(new Error("rate limited"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors, 1);
  await cache.get("view", async () => {
    loads++;
    return "unexpected";
  });
  assert.equal(loads, 1);
  now += 1000;
  await cache.get("view", async () => {
    loads++;
    return "new";
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads, 2);
  assert.equal((await cache.get("view", async () => "unused")).value, "new");
});

test("an obsolete failed refresh cannot delay a newly invalidated generation", async () => {
  let now = 100;
  const cache = new ViewCache<string>({
    maxEntries: 4,
    staleAfterMs: 10,
    now: () => now,
    onBackgroundError: () => {},
  });
  cache.set("view", "saved");
  now += 11;
  const pending = deferred<string>();
  await cache.get("view", () => pending.promise);
  cache.markStale((key) => key === "view");
  pending.reject(new Error("obsolete failure"));
  await new Promise((resolve) => setImmediate(resolve));
  let refreshed = false;
  await cache.get("view", async () => {
    refreshed = true;
    return "current";
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshed, true);
  assert.equal(
    (await cache.get("view", async () => "unused")).value,
    "current",
  );
});
