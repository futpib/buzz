import assert from "node:assert/strict";
import test from "node:test";

import { messageLinkRoute, parseMessageLink } from "./message-link";

const channelId = "90db6dbb-a9f1-4c04-a4bb-eb5d2beec82b";
const messageId = "a".repeat(64);
const threadRootId = "b".repeat(64);

test("canonical Buzz message links route to the exact visible web branch", () => {
  const parsed = parseMessageLink(
    `buzz://message?channel=${channelId}&id=${messageId}&thread=${threadRootId}`,
  );
  assert.deepEqual(parsed, { channelId, messageId, threadRootId });
  assert.equal(
    messageLinkRoute(parsed),
    `/channels/${channelId}?thread=${threadRootId}&message=${messageId}`,
  );

  const root = parseMessageLink(
    `buzz://message?channel=${channelId}&id=${messageId}`,
  );
  assert.ok(root);
  assert.equal(
    messageLinkRoute(root),
    `/channels/${channelId}?thread=${messageId}&message=${messageId}`,
  );
});

test("message link parsing rejects ambiguous and malformed navigation targets", () => {
  for (const value of [
    `https://message?channel=${channelId}&id=${messageId}`,
    `buzz://message/path?channel=${channelId}&id=${messageId}`,
    `buzz://message?channel=${channelId}&id=${messageId}#fragment`,
    `buzz://message?channel=${channelId}&id=${messageId}&extra=true`,
    `buzz://message?channel=${channelId}&channel=${channelId}&id=${messageId}`,
    `buzz://message?channel=${channelId}&id=${messageId}&id=${messageId}`,
    `buzz://message?channel=not-a-uuid&id=${messageId}`,
    `buzz://message?channel=${channelId}&id=not-an-event`,
    `buzz://message?channel=${channelId}&id=${messageId}&thread=`,
  ]) {
    assert.equal(parseMessageLink(value), null, value);
  }
});
