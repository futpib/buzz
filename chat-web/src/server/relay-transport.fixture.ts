import assert from "node:assert/strict";
import test from "node:test";
import { RelayConnection } from "./relay";
import type { NostrEvent } from "./types";

class FakeSocket extends EventTarget {
  static OPEN = 1;
  readyState = 0;
  static latest: FakeSocket;
  mode: "complete" | "drop" | "hold" = "complete";
  requests: string[] = [];
  constructor() {
    super();
    FakeSocket.latest = this;
    queueMicrotask(() => {
      this.readyState = FakeSocket.OPEN;
      this.dispatchEvent(new Event("open"));
      this.frame(["AUTH", "challenge"]);
    });
  }
  frame(frame: unknown[]) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(frame) }),
    );
  }
  send(data: string) {
    const frame = JSON.parse(data);
    if (frame[0] === "AUTH")
      queueMicrotask(() => this.frame(["OK", frame[1].id, true, ""]));
    if (frame[0] === "EVENT")
      queueMicrotask(() =>
        this.frame([
          "OK",
          frame[1].id,
          true,
          'response:{"channel_id":"test-channel"}',
        ]),
      );
    if (frame[0] === "REQ") {
      this.requests.push(frame[1]);
      queueMicrotask(() => {
        if (this.mode === "drop") this.close();
        else if (this.mode === "complete") this.frame(["EOSE", frame[1]]);
      });
    }
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

test("the production relay query finishes immediately when its socket closes", async () => {
  const original = globalThis.WebSocket;
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: FakeSocket,
  });
  process.env.BUZZ_RELAY_URL = "wss://relay.test";
  try {
    const relay = await RelayConnection.open();
    await relay.authenticate({ id: "proof" } as NostrEvent);
    assert.deepEqual(await relay.query([{ kinds: [9] }]), []);
    assert.equal(
      await relay.publishCommand({ id: "dm-command" } as NostrEvent),
      'response:{"channel_id":"test-channel"}',
    );
    assert.equal(
      await relay.publish({ id: "message" } as NostrEvent),
      undefined,
    );
    FakeSocket.latest.requests = [];
    FakeSocket.latest.mode = "hold";
    const concurrent = Array.from({ length: 3 }, () =>
      relay.query([{ kinds: [9] }]),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      FakeSocket.latest.requests.length,
      2,
      "only two REQs may be active on a connection",
    );
    FakeSocket.latest.frame(["EOSE", FakeSocket.latest.requests[0]]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(FakeSocket.latest.requests.length, 3);
    FakeSocket.latest.frame(["EOSE", FakeSocket.latest.requests[1]]);
    FakeSocket.latest.frame(["EOSE", FakeSocket.latest.requests[2]]);
    await Promise.all(concurrent);
    FakeSocket.latest.mode = "drop";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await assert.rejects(
        Promise.race([
          relay.query([{ kinds: [9] }]),
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(new Error("query remained pending after socket close")),
              100,
            );
          }),
        ]),
        /Relay WebSocket closed during query/,
      );
    } finally {
      clearTimeout(timer);
    }
  } finally {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: original,
    });
  }
});
