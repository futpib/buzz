import assert from "node:assert/strict";
import test from "node:test";

import {
  browserTitle,
  BUZZ_TITLE_TEMPLATE,
  channelPageTitle,
  PAGE_TITLES,
} from "./page-title";

test("every top-level page has a distinct Buzz title", () => {
  assert.equal(BUZZ_TITLE_TEMPLATE, "%s — Buzz");
  assert.deepEqual(PAGE_TITLES, {
    activity: "Activity",
    error: "Unavailable",
    home: "Home",
    inbox: "Inbox",
    login: "Sign in",
    notFound: "Page not found",
    sent: "Sent",
    threads: "Threads",
  });
  assert.equal(browserTitle(PAGE_TITLES.inbox), "Inbox — Buzz");
});

test("channel titles distinguish channels, DMs, and open threads", () => {
  assert.equal(
    channelPageTitle({ name: "engineering", type: "stream" }, false),
    "#engineering",
  );
  assert.equal(
    channelPageTitle({ name: "engineering", type: "stream" }, true),
    "Thread in #engineering",
  );
  assert.equal(channelPageTitle({ name: "Alice", type: "dm" }, false), "Alice");
});
