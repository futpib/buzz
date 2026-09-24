import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { ChannelView, MessageView } from "@/server/types";
import { MessageBody } from "@/ui/MessageBody";
import { MessageContextMenu } from "@/ui/MessageContextMenu";

const message: MessageView = {
  id: "a".repeat(64),
  threadRootId: "b".repeat(64),
  parentId: "b".repeat(64),
  author: {
    pubkey: "c".repeat(64),
    name: "Reader",
    picture: null,
    initials: "RE",
    color: "#123456",
  },
  content: "A message",
  createdAt: 1_700_000_000,
  editedAt: null,
  isOwn: false,
  replyCount: 0,
  lastReplyAt: null,
  replyParticipants: [],
  reactions: [],
};

const channels: ChannelView[] = [];

test("live parent renders preserve message media and reaction-picker focus", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "https://buzz.test/",
  });
  const replacements = {
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    MouseEvent: dom.window.MouseEvent,
    navigator: dom.window.navigator,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    window: dom.window,
  };
  const previous = new Map(
    Object.keys(replacements).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  Object.defineProperty(dom.window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: { configurable: true, value: () => undefined },
    detachEvent: { configurable: true, value: () => undefined },
  });

  let mediaRoot: Root | null = null;
  let menuRoot: Root | null = null;
  try {
    const mediaContainer = document.createElement("div");
    document.body.append(mediaContainer);
    const mountedMediaRoot = createRoot(mediaContainer);
    mediaRoot = mountedMediaRoot;
    const mediaContent = "![chart](https://example.test/chart.png)";
    const renderMedia = (revision: number) =>
      createElement(
        "div",
        { "data-revision": revision },
        createElement(MessageBody, { channels, content: mediaContent }),
      );

    flushSync(() => mountedMediaRoot.render(renderMedia(1)));
    const firstImage = mediaContainer.querySelector("img");
    assert.ok(firstImage);
    flushSync(() => mountedMediaRoot.render(renderMedia(2)));
    assert.equal(
      mediaContainer.querySelector("img") === firstImage,
      true,
      "unchanged message media was remounted",
    );
    flushSync(() => mountedMediaRoot.unmount());
    mediaRoot = null;
    mediaContainer.remove();

    const menuContainer = document.createElement("div");
    document.body.append(menuContainer);
    const mountedMenuRoot = createRoot(menuContainer);
    menuRoot = mountedMenuRoot;
    const renderMenu = (close: () => void) =>
      createElement(MessageContextMenu, {
        channelId: "channel",
        close,
        expectedPubkey: "d".repeat(64),
        message,
        onChange: () => undefined,
        isFollowing: false,
        isUnread: false,
        onFollowChange: () => undefined,
        onUnreadChange: () => undefined,
        point: { x: 20, y: 20 },
      });

    flushSync(() => mountedMenuRoot.render(renderMenu(() => undefined)));
    const more = document.querySelector<HTMLButtonElement>(
      'button[aria-label="More reactions"]',
    );
    assert.ok(more);
    flushSync(() => more.click());
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search emoji"]',
    );
    assert.ok(input);
    input.focus();
    assert.equal(document.activeElement === input, true);

    flushSync(() => mountedMenuRoot.render(renderMenu(() => undefined)));
    assert.equal(
      document.querySelector('input[aria-label="Search emoji"]') === input,
      true,
      "reaction input was remounted",
    );
    assert.equal(
      document.activeElement === input,
      true,
      "reaction input lost focus during a parent refresh",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    flushSync(() => mountedMenuRoot.unmount());
    menuRoot = null;
    menuContainer.remove();
  } finally {
    if (menuRoot) flushSync(() => menuRoot?.unmount());
    if (mediaRoot) flushSync(() => mediaRoot?.unmount());
    await new Promise((resolve) => setTimeout(resolve, 20));
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
