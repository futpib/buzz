import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createElement, useRef, useState, type FocusEvent } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { useMentions } from "./use-mentions";

// Exercise the production hook's commit boundary, without an animation frame:
// waiting a frame here would conceal immediate-typing/caret regressions.
test("picker insertion settles the caret synchronously and preserves intentional movement", async () => {
  const dom = new JSDOM("<html><body><div id='app'></div></body></html>", {
    pretendToBeVisual: true,
  });
  const replacements = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
  };
  const previous = new Map(
    Object.keys(replacements).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(replacements))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: { value: () => undefined },
    detachEvent: { value: () => undefined },
  });
  let controller!: ReturnType<typeof useMentions>;
  function Harness() {
    const [content, setContent] = useState("@Al trailing");
    const textarea = useRef<HTMLTextAreaElement>(null);
    controller = useMentions({
      channelId: "test",
      identity: "test",
      content,
      onChange: setContent,
      textarea,
    });
    return createElement("textarea", {
      ref: textarea,
      value: content,
      onChange: () => {},
    });
  }
  const root = createRoot(document.getElementById("app") as HTMLElement);
  try {
    flushSync(() => root.render(createElement(Harness)));
    const input = document.querySelector("textarea") as HTMLTextAreaElement;
    const group = input.parentElement as HTMLElement;
    group.className = "message-menu-form";
    const save = document.createElement("button");
    save.textContent = "Save";
    group.append(save);
    input.setSelectionRange(3, 3);
    flushSync(() => controller.inputProps.onClick());
    flushSync(() =>
      controller.inputProps.onBlur({
        currentTarget: input,
        relatedTarget: save,
      } as unknown as FocusEvent<HTMLTextAreaElement>),
    );
    assert.equal(
      controller.open,
      true,
      "Save must not move between pointer-down and click",
    );
    flushSync(() =>
      controller.pick({ name: "Alice Smith", pubkey: "a".repeat(64) }),
    );
    assert.equal(input.value, "@Alice Smith  trailing");
    assert.equal(input.selectionStart, "@Alice Smith ".length);
    input.setSelectionRange(input.selectionStart - 1, input.selectionStart - 1);
    flushSync(() => root.render(createElement(Harness)));
    assert.equal(input.selectionStart, "@Alice Smith".length);
  } finally {
    flushSync(() => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
