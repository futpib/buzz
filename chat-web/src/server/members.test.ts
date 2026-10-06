import assert from "node:assert/strict";
import test from "node:test";
import { loadMemberKeys, validateMentionMembers } from "./members";
import type { AuthSession } from "./auth";
import type { NostrEvent } from "./types";
const channel = "90db6dbb-a9f1-4c04-a4bb-eb5d2beec82b";
const own = "a".repeat(64),
  member = "b".repeat(64);
const event = (tags: string[][], kind = 39002): NostrEvent => ({
  id: "e".repeat(64),
  pubkey: own,
  created_at: 1,
  kind,
  content: "",
  sig: "",
  tags,
});
function session(events: NostrEvent[]) {
  return {
    pubkey: own,
    relay: { query: async () => events },
  } as unknown as AuthSession;
}
test("roster uses current channel membership and excludes malformed keys", async () => {
  const current = session([
    event([
      ["d", channel],
      ["p", own],
      ["p", member],
      ["p", "bad"],
    ]),
  ]);
  assert.deepEqual(await loadMemberKeys(current, channel), [own, member]);
  await validateMentionMembers(
    current,
    event(
      [
        ["h", channel],
        ["p", member],
      ],
      9,
    ),
  );
  await assert.rejects(
    validateMentionMembers(
      current,
      event(
        [
          ["h", channel],
          ["p", "c".repeat(64)],
        ],
        9,
      ),
    ),
    /no longer/,
  );
  await assert.rejects(
    validateMentionMembers(
      current,
      event(
        [
          ["h", channel],
          ["p", "bad"],
        ],
        9,
      ),
    ),
    /invalid/,
  );
});
test("missing membership fails closed instead of returning a cached or partial roster", async () => {
  for (const events of [
    [],
    [
      event([
        ["d", channel],
        ["p", member],
      ]),
    ],
    [
      event([
        ["d", "another"],
        ["p", own],
      ]),
    ],
  ]) {
    await assert.rejects(
      loadMemberKeys(session(events), channel),
      /membership/,
    );
  }
  await assert.rejects(loadMemberKeys(session([]), "bad"), /Invalid channel/);
});
