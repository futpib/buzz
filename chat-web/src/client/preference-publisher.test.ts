import assert from "node:assert/strict";
import test from "node:test";
import { PreferencePublisher } from "./preference-publisher";

const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

test("an older acknowledgement cannot lose an edit made while publishing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let pending: string[] = [];
  const writes: (() => void)[] = [];
  const publisher = new PreferencePublisher({
    initial: [],
    changed: (value) => {
      pending = value;
    },
    send: () => new Promise<void>((resolve) => writes.push(resolve)),
  });
  publisher.enqueue("channel-stars");
  assert.deepEqual(pending, ["channel-stars"]);
  t.mock.timers.tick(800);
  publisher.enqueue("channel-stars");
  publisher.retry();
  t.mock.timers.tick(5000);
  assert.equal(writes.length, 1, "writes for a coordinate cannot overlap");
  writes[0]();
  await settle();
  assert.deepEqual(pending, ["channel-stars"]);
  t.mock.timers.tick(0);
  assert.equal(writes.length, 2);
  writes[1]();
  await settle();
  assert.deepEqual(pending, []);
  t.mock.timers.tick(60_000);
  assert.equal(
    writes.length,
    2,
    "no stale timer republishes an acknowledged value",
  );
  publisher.dispose();
});

test("saved pending writes retry, expose the real error, and clear after recovery", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let failures = 3;
  let pending: string[] = ["channel-sort"];
  let error: string | null = null;
  const publisher = new PreferencePublisher({
    initial: pending,
    changed: (value, reason) => {
      pending = value;
      error = reason;
    },
    send: async () => {
      if (failures-- > 0) throw new Error("Relay temporarily unavailable");
    },
  });
  publisher.retry();
  t.mock.timers.tick(0);
  await settle();
  t.mock.timers.tick(2000);
  await settle();
  t.mock.timers.tick(4000);
  await settle();
  assert.match(error ?? "", /Relay temporarily unavailable/);
  assert.deepEqual(pending, ["channel-sort"]);
  publisher.retry();
  t.mock.timers.tick(0);
  await settle();
  assert.deepEqual(pending, []);
  assert.equal(error, null);
  publisher.dispose();
});
