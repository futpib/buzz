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
