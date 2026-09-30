import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { useRefreshingView } from "./use-refreshing-view";

test("live snapshots fence older HTTP results and retain data through refresh failures", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", {
    pretendToBeVisual: true,
  });
  const sources: FakeSource[] = [];
  class FakeSource extends EventTarget {
    static CLOSED = 2;
    readyState = 1;
    onerror: (() => void) | null = null;
    constructor() {
      super();
      sources.push(this);
    }
    close() {
      this.readyState = FakeSource.CLOSED;
    }
    snapshot(view: unknown) {
      this.dispatchEvent(
        new MessageEvent("snapshot", { data: JSON.stringify(view) }),
      );
    }
  }
  let finish: ((response: Response) => void) | undefined;
  const replacements = {
    window: dom.window,
    document: dom.window.document,
    EventSource: FakeSource,
    fetch: () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  };
  const previous = new Map(
    Object.keys(replacements).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(replacements))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const initial = {
    generatedAt: Date.now(),
    cacheState: "fresh",
    identity: { pubkey: "viewer" },
    content: "saved",
  };
  let state: ReturnType<typeof useRefreshingView<typeof initial>> | undefined;
  function Probe() {
    state = useRefreshingView(initial, "/view", "Test", "/live");
    return createElement("p", null, state.view.content);
  }
  const container = document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  const current = () => {
    assert.ok(state);
    return state;
  };
  const respond = (response: Response) => {
    assert.ok(finish);
    finish(response);
  };
  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    flushSync(() => {});
  };
  try {
    flushSync(() => root.render(createElement(Probe)));
    assert.equal(sources.length, 1);
    sources[0].snapshot({
      ...initial,
      generatedAt: initial.generatedAt + 1,
      content: "catch-up",
    });
    await settle();
    current().refresh();
    await settle();
    assert.equal(current().refreshing, true);
    assert.equal(current().view.content, "catch-up");
    sources[0].snapshot({
      ...initial,
      generatedAt: initial.generatedAt + 3,
      content: "newest",
    });
    respond(
      Response.json({
        ...initial,
        generatedAt: initial.generatedAt + 2,
        content: "obsolete",
      }),
    );
    await settle();
    assert.equal(current().view.content, "newest");
    assert.equal(current().refreshing, false);
    current().refresh();
    await settle();
    respond(Response.json({ error: "relay down" }, { status: 500 }));
    await settle();
    assert.equal(current().view.content, "newest");
    assert.equal(current().error, "relay down");
    current().refresh();
    await settle();
    respond(
      Response.json({
        ...initial,
        generatedAt: initial.generatedAt + 4,
        content: "recovered",
      }),
    );
    await settle();
    assert.equal(current().view.content, "recovered");
    assert.equal(current().error, null);
    finish = undefined;
    sources[0].close();
    sources[0].onerror?.();
    await settle();
    assert.equal(current().error, "Live connection interrupted");
    assert.equal(
      finish,
      undefined,
      "a failed SSE endpoint must not spin HTTP retries",
    );
    current().refresh();
    await settle();
    respond(
      Response.json({ ...initial, generatedAt: initial.generatedAt + 5 }),
    );
    await settle();
    assert.equal(
      sources.length,
      2,
      "manual retry reopens a terminally closed stream",
    );
    flushSync(() => root.unmount());
    assert.equal(sources[0].readyState, FakeSource.CLOSED);
  } finally {
    flushSync(() => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 20));
    dom.window.close();
    for (const [key, value] of previous) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
