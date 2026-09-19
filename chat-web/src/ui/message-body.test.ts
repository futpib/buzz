import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageBody } from "./MessageBody";

test("message links open outside the app with opener isolation", () => {
  const html = renderToStaticMarkup(
    createElement(MessageBody, {
      content: "Read [the docs](https://example.com/docs).",
    }),
  );

  assert.match(
    html,
    /<a href="https:\/\/example\.com\/docs" rel="noopener noreferrer" target="_blank">the docs<\/a>/,
  );
});

test("relay attachments use the authenticated new-tab control", () => {
  const hash = "a".repeat(64);
  const html = renderToStaticMarkup(
    createElement(MessageBody, {
      content: `[report.pdf](https://relay.example/media/${hash}.pdf)`,
    }),
  );

  assert.match(html, /class="message-attachment-link"/);
  assert.match(html, /Open attachment in a new tab: report\.pdf/);
  assert.doesNotMatch(
    html,
    new RegExp(`href="https://relay.example/media/${hash}`),
  );
});
