import assert from "node:assert/strict";
import test from "node:test";

import { messageLink } from "./MessageContextMenu";

test("context-menu copy link uses the cross-client Buzz message shape", () => {
  const channelId = "90db6dbb-a9f1-4c04-a4bb-eb5d2beec82b";
  const id = "a".repeat(64);
  const threadRootId = "b".repeat(64);

  assert.equal(
    messageLink(channelId, { id, threadRootId: null }),
    `buzz://message?channel=${channelId}&id=${id}`,
  );
  assert.equal(
    messageLink(channelId, { id, threadRootId }),
    `buzz://message?channel=${channelId}&id=${id}&thread=${threadRootId}`,
  );
});
