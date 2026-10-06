import assert from "node:assert/strict";
import test from "node:test";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools";
import {
  conversationCommand,
  type ConversationAction,
} from "@/shared/conversations";
import {
  validateConversationEvent,
  dmChannelFromAck,
} from "./conversation-validation";
import {
  loadConversationDetails,
  queryDirectoryPages,
  loadConversationDirectory,
} from "./conversations";
import type { AuthSession } from "./auth";
import type { NostrEvent } from "./types";
const key = generateSecretKey(),
  own = getPublicKey(key),
  other = "b".repeat(64);
const channel = "a0000000-0000-4000-8000-000000000001";
const sign = (kind: number, tags: string[][], content = "") =>
  finalizeEvent(
    { kind, tags, content, created_at: Math.floor(Date.now() / 1000) },
    key,
  );
const inputs: ConversationAction[] = [
  { action: "dm", pubkeys: [other] },
  {
    action: "create",
    channelId: channel,
    name: "# Project",
    about: "Description",
    visibility: "private",
    type: "forum",
  },
  { action: "join", channelId: channel },
  { action: "leave", channelId: channel },
  { action: "add", channelId: channel, pubkey: other },
  { action: "add", channelId: channel, pubkey: other, role: "owner" },
  { action: "remove", channelId: channel, pubkey: other },
  {
    action: "update",
    channelId: channel,
    changes: { topic: "Hello", ttl: "", archived: "true" },
  },
];
test("conversation commands match SDK kinds and validate the exact signed intent", () => {
  assert.deepEqual(
    inputs.map((input) => conversationCommand(input).kind),
    [41010, 9007, 9021, 9022, 9000, 9000, 9001, 9002],
  );
  for (const input of inputs) {
    const command = conversationCommand(input),
      event = sign(command.kind, command.tags);
    validateConversationEvent(own, input, event);
    assert.throws(
      () => validateConversationEvent(other, input, event),
      /signer/,
    );
    assert.throws(
      () => validateConversationEvent(own, input, event, event.created_at + 61),
      /expired/,
    );
    assert.throws(
      () =>
        validateConversationEvent(
          own,
          input,
          sign(command.kind, [...command.tags, ["p", own]]),
        ),
      /match/,
    );
  }
  assert.deepEqual(
    conversationCommand(inputs[1]).tags.find((t) => t[0] === "name"),
    ["name", "Project"],
  );
  assert.equal(
    dmChannelFromAck(`response:{"channel_id":"${channel}"}`),
    channel,
  );
  assert.equal(dmChannelFromAck(`{"channel_id":"${channel}"}`), channel);
  assert.equal(dmChannelFromAck("duplicate: already processed"), null);
});
test("conversation boundary rejects malformed and unsupported operations", () => {
  assert.throws(
    () => conversationCommand({ action: "dm", pubkeys: [] }),
    /Choose/,
  );
  assert.throws(
    () => conversationCommand({ action: "dm", pubkeys: Array(9).fill(other) }),
    /Choose/,
  );
  assert.throws(
    () => conversationCommand({ action: "join", channelId: "invalid" }),
    /channel/,
  );
  for (const changes of [
    { visibility: "public" },
    { ttl: "-1" },
    { ttl: "0" },
    { ttl: "2147483648" },
    { archived: "yes" },
    { name: "###" },
    { channel_type: "dm" },
    {},
  ] as Record<string, string>[])
    assert.throws(() =>
      conversationCommand({ action: "update", channelId: channel, changes }),
    );
  assert.throws(
    () =>
      validateConversationEvent(
        own,
        inputs[0],
        sign(39002, [
          ["d", channel],
          ["p", own],
        ]),
      ),
    /match/,
  );
});
function session(role = "member", secondOwner = false): AuthSession {
  const events = [
    sign(39000, [
      ["d", channel],
      ["name", "Test"],
      ["t", "stream"],
      ["private"],
    ]),
    sign(39002, [
      ["d", channel],
      ["p", own, "", role],
      ["p", other, "", secondOwner ? "owner" : "member"],
    ]),
  ];
  return {
    pubkey: own,
    cacheScope: crypto.randomUUID(),
    relay: {
      query: async (filters: Record<string, unknown>[]) =>
        events.filter((e) => (filters[0].kinds as number[]).includes(e.kind)),
    },
  } as unknown as AuthSession;
}
test("channel details preserve roles and last-owner protection", async () => {
  const owner = await loadConversationDetails(session("owner"), channel);
  assert.equal(owner.canManage, true);
  assert.equal(owner.canLeave, false);
  assert.equal(owner.members[0].role, "owner");
  const shared = await loadConversationDetails(session("owner", true), channel);
  assert.equal(shared.canLeave, true);
  const member = await loadConversationDetails(session(), channel);
  assert.equal(member.canManage, false);
  assert.equal(member.canLeave, true);
  const outsider = session();
  outsider.pubkey = "c".repeat(64);
  await assert.rejects(
    loadConversationDetails(outsider, channel),
    /membership/,
  );
});
test("directory lists open channels and joined private channels without exposing other private channels or DMs", async () => {
  const s = session();
  const extra = (id: string, type: string, visibility: string) =>
    sign(39000, [["d", id], ["name", id], ["t", type], [visibility]]);
  const channels = [
    extra(channel, "stream", "private"),
    extra("open", "forum", "public"),
    extra("secret", "stream", "private"),
    extra("dm", "dm", "public"),
  ];
  s.relay.query = async (filters) =>
    filters[0].kinds && (filters[0].kinds as number[]).includes(39000)
      ? channels
      : (filters[0].kinds as number[]).includes(39002)
        ? [
            sign(39002, [
              ["d", channel],
              ["p", own],
            ]),
          ]
        : [];
  const directory = await loadConversationDirectory(s, true);
  assert.deepEqual(
    directory.channels.map((c) => c.id).sort(),
    [channel, "open"].sort(),
  );
  assert.equal(directory.channels.find((c) => c.id === channel)?.joined, true);
});
test("directory pages beyond 500 entries and rejects a stuck cursor", async () => {
  const first = Array.from({ length: 500 }, (_, i) => ({
    ...sign(0, []),
    id: String(i),
    created_at: 1000 - i,
  }));
  let calls = 0;
  const s = {
    relay: {
      query: async (filters: Record<string, unknown>[]) => {
        calls++;
        if (calls === 1) return first;
        assert.equal(filters[0].before_id, "499");
        assert.equal(filters[0].until, 501);
        return [{ ...first[0], id: "last" }];
      },
    },
  } as unknown as Pick<AuthSession, "relay">;
  assert.equal((await queryDirectoryPages(s, { kinds: [0] })).length, 501);
  s.relay.query = async () => first as NostrEvent[];
  await assert.rejects(queryDirectoryPages(s, { kinds: [0] }), /stalled/);
});
