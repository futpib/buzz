import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MessageRow } from "./MessageRow";
import type { MessageView } from "@/server/types";

const message: MessageView = {
  id: "a".repeat(64),
  threadRootId: null,
  parentId: null,
  author: {
    pubkey: "b".repeat(64),
    name: "Reader",
    picture: null,
    initials: "RE",
    color: "#123456",
  },
  content: "Selectable message text with [a link](https://example.test/).",
  createdAt: 1700000000,
  editedAt: null,
  isOwn: false,
  replyCount: 0,
  lastReplyAt: null,
  replyParticipants: [],
  reactions: [],
};

test("message rows preserve mobile, link, and selection context menus while retaining explicit actions", async () => {
  const dom = new JSDOM("<html><body><div id='app'></div></body></html>", {
    pretendToBeVisual: true,
    url: "https://buzz.test",
  });
  const replacements = {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    navigator: dom.window.navigator,
  };
  const previous = new Map(
    Object.keys(replacements).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(replacements))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  let coarse = true;
  Object.defineProperty(dom.window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: coarse }),
  });
  const root = createRoot(document.getElementById("app") as HTMLElement);
  const menu = () =>
    document.querySelector('[role="dialog"][aria-label="Message actions"]');
  const contextMenu = (target: Element) => {
    const event = new dom.window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    flushSync(() => target.dispatchEvent(event));
    return event;
  };
  const pointer = (
    target: Element,
    type: string,
    name = "pointerdown",
    x = 0,
  ) => {
    const event = new dom.window.MouseEvent(name, {
      clientX: x,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperties(event, {
      pointerType: { value: type },
      isPrimary: { value: true },
      pointerId: { value: 1 },
    });
    flushSync(() => target.dispatchEvent(event));
  };
  try {
    flushSync(() =>
      root.render(
        createElement(MessageRow, {
          message,
          channelId: "channel",
          expectedPubkey: "c".repeat(64),
          onMessageChange: () => {},
          channels: [],
        }),
      ),
    );
    const dismiss = () =>
      flushSync(() =>
        (
          document.querySelector(
            '[aria-label="Dismiss message actions"]',
          ) as HTMLButtonElement
        ).click(),
      );
    const row = document.querySelector("article") as HTMLElement;
    const background = document.querySelector(
      ".message-content",
    ) as HTMLElement;
    const paragraph = document.querySelector(".message-body p") as HTMLElement;
    const link = paragraph.querySelector("a") as HTMLAnchorElement;
    for (const target of [row, background]) {
      pointer(target, "touch");
      await new Promise((resolve) => setTimeout(resolve, 550));
      assert.ok(menu(), "background long press opens message actions");
      pointer(target, "touch", "pointerup");
      const releaseClick = new dom.window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      flushSync(() =>
        document
          .querySelector(".message-menu-backdrop")
          ?.dispatchEvent(releaseClick),
      );
      assert.equal(
        releaseClick.defaultPrevented,
        true,
        "release must not dismiss the newly opened menu",
      );
      assert.ok(menu());
      const click = new dom.window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      flushSync(() => link.dispatchEvent(click));
      assert.equal(
        click.defaultPrevented,
        false,
        "background hold must not swallow a later link click",
      );
      dismiss();
      assert.equal(contextMenu(target).defaultPrevented, true);
      dismiss();
    }
    for (const name of ["pointermove", "pointerup", "pointercancel"]) {
      pointer(row, "touch");
      pointer(row, "touch", name, 20);
      await new Promise((resolve) => setTimeout(resolve, 550));
      assert.equal(menu(), null, `${name} cancels background long press`);
    }
    pointer(paragraph, "touch");
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(
      menu(),
      null,
      "long-press must not open an app menu over native selection",
    );
    assert.equal(contextMenu(paragraph).defaultPrevented, false);
    assert.equal(contextMenu(link).defaultPrevented, false);
    coarse = false;
    assert.equal(
      contextMenu(paragraph).defaultPrevented,
      false,
      "touch on a hybrid computer stays native",
    );
    pointer(paragraph, "mouse");
    assert.equal(
      contextMenu(link).defaultPrevented,
      false,
      "desktop links retain browser actions too",
    );
    const keyboard = new dom.window.KeyboardEvent("keydown", {
      key: "ContextMenu",
      bubbles: true,
      cancelable: true,
    });
    flushSync(() => link.dispatchEvent(keyboard));
    assert.equal(keyboard.defaultPrevented, false);
    const selection = dom.window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    selection?.removeAllRanges();
    selection?.addRange(range);
    assert.equal(contextMenu(paragraph).defaultPrevented, false);
    assert.equal(
      contextMenu(row).defaultPrevented,
      false,
      "background preserves an existing selection",
    );
    pointer(row, "touch");
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(menu(), null);
    pointer(paragraph, "mouse");
    assert.ok(selection?.toString().includes("Selectable message text"));
    selection?.removeAllRanges();
    assert.equal(
      contextMenu(paragraph).defaultPrevented,
      true,
      "unselected desktop message retains its action menu",
    );
    assert.ok(menu());
    flushSync(() =>
      (
        document.querySelector(
          '[aria-label="Dismiss message actions"]',
        ) as HTMLButtonElement
      ).click(),
    );
    assert.equal(menu(), null);
    coarse = true;
    flushSync(() =>
      (
        document.querySelector(".message-menu-trigger") as HTMLButtonElement
      ).click(),
    );
    assert.ok(menu(), "touch users can still open actions explicitly");
  } finally {
    flushSync(() => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 20));
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
