import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TypingIndicator, typingLabel } from "./TypingIndicator";

const participants = ["Ana", "Ben", "Cy", "Dee"].map((name) => ({
  pubkey: name,
  name,
}));

test("typing labels cover singular, plural, and overflow states", () => {
  assert.equal(typingLabel(participants.slice(0, 1)), "Ana is typing");
  assert.equal(typingLabel(participants.slice(0, 2)), "Ana and Ben are typing");
  assert.equal(
    typingLabel(participants.slice(0, 3)),
    "Ana, Ben, and Cy are typing",
  );
  assert.equal(typingLabel(participants), "Ana, Ben, and 2 others are typing");
});

test("typing indicator announces its visible state", () => {
  const html = renderToStaticMarkup(
    createElement(TypingIndicator, {
      participants: participants.slice(0, 1),
    }),
  );
  assert.match(html, /role="status"/);
  assert.match(html, /Ana is typing/);
});
