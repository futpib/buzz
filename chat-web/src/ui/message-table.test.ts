import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageBody } from "@/ui/MessageBody";

const table = `| Name | Notes | Amount |
| :--- | :--- | ---: |
| **Alpha** | [Details](https://example.com/details) and \`code\` | 123 |
| Beta | | 456 |`;

test("table previews retain semantic cells without expanding truncated content", () => {
  const dom = new JSDOM(
    renderToStaticMarkup(
      createElement(MessageBody, { content: table, preview: true }),
    ),
  );
  assert.equal(dom.window.document.querySelectorAll("table").length, 1);
  assert.equal(dom.window.document.querySelectorAll("th").length, 3);
  assert.equal(dom.window.document.querySelectorAll("button").length, 0);
  dom.window.close();
});

test("per-table views preserve rich cells and remain independent across message refreshes", async () => {
  const dom = new JSDOM("<html><body><div id='app'></div></body></html>", {
    url: "https://buzz.test",
  });
  const replacements = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  };
  const previous = new Map(
    Object.keys(replacements).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(replacements))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.getElementById("app");
  assert.ok(container);
  const root = createRoot(container);
  try {
    const content = `${table}\n\nSecond table\n\n${table}`;
    const render = () =>
      flushSync(() =>
        root.render(createElement(MessageBody, { content, channels: [] })),
      );
    render();
    const tables = document.querySelectorAll(".message-table");
    assert.equal(tables.length, 2);
    const second = tables[1];
    const cards = second.querySelector<HTMLButtonElement>(
      'button[aria-pressed="false"]',
    );
    assert.ok(cards);
    flushSync(() => cards.click());
    assert.equal(tables[0].querySelector(".message-table-cards"), null);
    const rows = second.querySelectorAll(".message-table-card");
    assert.equal(rows.length, 2);
    assert.deepEqual(
      [...rows[0].querySelectorAll("dt")].map((x) => x.textContent),
      ["Name", "Notes", "Amount"],
    );
    assert.deepEqual(
      [...rows[0].querySelectorAll("dd")].map((x) => x.textContent),
      ["Alpha", "Details and code", "123"],
    );
    assert.equal(rows[0].querySelector("dd strong")?.textContent, "Alpha");
    assert.equal(rows[0].querySelector("dd code")?.textContent, "code");
    assert.equal(
      rows[0].querySelector("dd a")?.getAttribute("target"),
      "_blank",
    );
    assert.equal(rows[1].querySelectorAll("dd")[1].textContent, "");
    render();
    assert.equal(document.querySelectorAll(".message-table")[1], second);
    assert.equal(second.querySelectorAll(".message-table-card").length, 2);
    const tableButton = second.querySelector<HTMLButtonElement>(
      'button[aria-pressed="false"]',
    );
    assert.ok(tableButton);
    flushSync(() => tableButton.click());
    assert.equal(second.querySelector(".message-table-cards"), null);
    assert.equal(second.querySelector("table")?.closest("[hidden]"), null);
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
