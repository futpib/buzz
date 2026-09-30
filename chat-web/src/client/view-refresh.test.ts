import assert from "node:assert/strict";
import test from "node:test";
import { startViewRefresh } from "./view-refresh";

function environment() {
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const win = new EventTarget();
  const previous = new Map(
    ["document", "window"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.defineProperty(globalThis, "document", {
    value: doc,
    configurable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: win,
    configurable: true,
  });
  return {
    doc,
    win,
    restore() {
      for (const [key, value] of previous) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("an open Inbox keeps refreshing, pauses while hidden, resumes and cleans up", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const env = environment();
  let calls = 0;
  let finish: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  const loop = startViewRefresh({
    label: "Inbox",
    delay: 15000,
    onState: () => {},
    load: (s) => {
      calls++;
      signal = s;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  });
  try {
    t.mock.timers.tick(15000);
    assert.equal(calls, 1);
    loop.refresh();
    env.win.dispatchEvent(new Event("focus"));
    assert.equal(calls, 1);
    finish?.();
    await settle();
    t.mock.timers.tick(15000);
    assert.equal(calls, 2);
    finish?.();
    await settle();
    env.doc.visibilityState = "hidden";
    t.mock.timers.tick(15000);
    assert.equal(calls, 2);
    env.doc.visibilityState = "visible";
    env.doc.dispatchEvent(new Event("visibilitychange"));
    assert.equal(calls, 3);
    finish?.();
    await settle();
    env.win.dispatchEvent(new Event("online"));
    assert.equal(calls, 4);
    loop.dispose();
    assert.equal(signal?.aborted, true);
    finish?.();
    await settle();
    env.win.dispatchEvent(new Event("focus"));
    t.mock.timers.tick(60000);
    assert.equal(calls, 4);
  } finally {
    loop.dispose();
    env.restore();
  }
});

test("failed and hung Inbox refreshes surface errors and recover with bounded retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const env = environment();
  let calls = 0;
  let hang = false;
  const states: [boolean, string | null][] = [];
  const loop = startViewRefresh({
    label: "Inbox",
    delay: 0,
    onState: (busy, error) => states.push([busy, error]),
    load: async (signal) => {
      calls++;
      if (hang)
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
      else if (calls <= 2) throw new Error("Relay unavailable");
    },
  });
  try {
    t.mock.timers.tick(0);
    await settle();
    assert.deepEqual(states.at(-1), [false, "Relay unavailable"]);
    t.mock.timers.tick(29999);
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(calls, 2);
    t.mock.timers.tick(59999);
    assert.equal(calls, 2);
    t.mock.timers.tick(1);
    await settle();
    assert.deepEqual(states.at(-1), [false, null]);
    hang = true;
    t.mock.timers.tick(15000);
    await settle();
    assert.equal(calls, 4);
    t.mock.timers.tick(30000);
    await settle();
    assert.deepEqual(states.at(-1), [false, "Inbox refresh timed out"]);
    hang = false;
    loop.refresh();
    await settle();
    assert.equal(calls, 5);
    assert.deepEqual(states.at(-1), [false, null]);
    t.mock.timers.tick(15000);
    await settle();
    assert.equal(calls, 6);
  } finally {
    loop.dispose();
    env.restore();
  }
});
