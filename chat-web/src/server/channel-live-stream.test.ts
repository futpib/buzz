import assert from "node:assert/strict";
import test from "node:test";
import { channelLiveStream } from "@/server/channel-live-stream";
import type { ChannelSnapshot } from "@/server/types";

test("a rejected subscription and failed catch-up retry without another channel event", {
  timeout: 10_000,
}, async () => {
  const abort = new AbortController();
  let subscriptions = 0;
  let loads = 0;
  const stream = channelLiveStream({
    signal: abort.signal,
    listen: async (dirty, _typing, signal) => {
      subscriptions++;
      if (subscriptions === 1) throw new Error("rate-limited");
      dirty();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
    load: async () => {
      loads++;
      if (loads === 1) throw new Error("temporary query failure");
      return { revision: "fresh" } as ChannelSnapshot;
    },
  });
  let output = "";
  try {
    for await (const chunk of stream) {
      output += new TextDecoder().decode(chunk);
      if (output.includes("event: snapshot")) break;
    }
    assert.equal(subscriptions, 2);
    assert.equal(loads, 2);
    assert.match(output, /rate-limited/);
    assert.match(output, /temporary query failure/);
    assert.match(output, /"revision":"fresh"/);
  } finally {
    abort.abort();
  }
});

test("canceling a pending refresh suppresses its result and stops the subscription", async () => {
  const abort = new AbortController();
  let complete: (value: ChannelSnapshot) => void = () => {};
  let stopped = false;
  const stream = channelLiveStream({
    signal: abort.signal,
    listen: async (dirty, _typing, signal) => {
      dirty();
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            stopped = true;
            resolve();
          },
          { once: true },
        ),
      );
    },
    load: () =>
      new Promise<ChannelSnapshot>((resolve) => {
        complete = resolve;
      }),
  });
  const reader = stream.getReader();
  await reader.read();
  await reader.cancel();
  complete({ revision: "late" } as ChannelSnapshot);
  await Promise.resolve();
  assert.equal(stopped, true);
  assert.equal((await reader.read()).done, true);
});
