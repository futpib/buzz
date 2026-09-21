import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageBody } from "./MessageBody";

const channelId = "90db6dbb-a9f1-4c04-a4bb-eb5d2beec82b";
const messageId = "a".repeat(64);
const threadRootId = "b".repeat(64);
const channels = [
  {
    id: channelId,
    name: "buzz",
    description: "",
    type: "stream" as const,
    visibility: "private" as const,
    archived: false,
  },
];

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

test("bare Buzz message links render as internal channel pills", () => {
  const link = `buzz://message?channel=${channelId}&id=${messageId}&thread=${threadRootId}`;
  const html = renderToStaticMarkup(
    createElement(MessageBody, {
      channels,
      content: `Earlier context: ${link}.`,
    }),
  );

  assert.match(html, /class="buzz-message-link"/);
  assert.match(html, /aria-label="Open message in channel buzz"/);
  assert.match(html, />#buzz</);
  assert.match(
    html,
    new RegExp(
      `href="/channels/${channelId}\\?thread=${threadRootId}&amp;message=${messageId}"`,
    ),
  );
  assert.doesNotMatch(html, />buzz:\/\/message\?/);
  assert.match(html, /<\/a>\.<\/p>/);
});

test("labeled Buzz message links keep their label and navigate in-app", () => {
  const link = `buzz://message?channel=${channelId}&id=${messageId}`;
  const html = renderToStaticMarkup(
    createElement(MessageBody, {
      channels,
      content: `[Earlier update](${link})`,
    }),
  );

  assert.match(html, /class="buzz-message-anchor"/);
  assert.match(html, />Earlier update<\/a>/);
  assert.doesNotMatch(html, /target="_blank"/);
});

test("malformed or unauthorized Buzz message links never become navigation", () => {
  const malformed = `buzz://message?channel=${channelId}&id=bad`;
  const valid = `buzz://message?channel=${channelId}&id=${messageId}`;
  const malformedHtml = renderToStaticMarkup(
    createElement(MessageBody, { channels, content: malformed }),
  );
  const unavailableHtml = renderToStaticMarkup(
    createElement(MessageBody, { content: valid }),
  );

  assert.match(malformedHtml, /buzz:\/\/message\?/);
  assert.doesNotMatch(malformedHtml, /href=/);
  assert.match(unavailableHtml, /buzz-message-link-unavailable/);
  assert.doesNotMatch(unavailableHtml, /href=/);
});
