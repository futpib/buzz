import assert from "node:assert/strict";
import test from "node:test";
import { RelayQueryQueue } from "./relay-query-queue";
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("relay queries cap concurrency, preserve FIFO order, and release failed slots", async () => {
  const queue = new RelayQueryQueue();
  const starts: number[] = [];
  const finish: (() => void)[] = [];
  const tasks = [0, 1, 2, 3].map((id) =>
    queue.run(async () => {
      starts.push(id);
      await new Promise<void>((resolve) => {
        finish[id] = resolve;
      });
      if (id === 0) throw new Error("failed query");
      return id;
    }),
  );
  const failed = assert.rejects(tasks[0], /failed query/);
  await settle();
  assert.deepEqual(starts, [0, 1]);
  finish[0]();
  await failed;
  await settle();
  assert.deepEqual(starts, [0, 1, 2]);
  finish[1]();
  await settle();
  assert.deepEqual(starts, [0, 1, 2, 3]);
  finish[2]();
  finish[3]();
  await Promise.all(tasks.slice(1));
});

test("queued relay work has a deadline and closes without starting on a dead socket", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const queue = new RelayQueryQueue();
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const active = [queue.run(() => hold), queue.run(() => hold)];
  const expired = assert.rejects(
    queue.run(async () => "must not run"),
    /queue timed out/,
  );
  t.mock.timers.tick(30_000);
  await expired;
  const closed = assert.rejects(
    queue.run(async () => "must not run"),
    /closed/,
  );
  queue.close(new Error("socket closed"));
  await closed;
  await assert.rejects(
    queue.run(async () => "must not run"),
    /closed/,
  );
  release();
  await Promise.all(active);
});
