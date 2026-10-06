import assert from "node:assert/strict";
import test from "node:test";
import {
  historicalMentions,
  mentionLabel,
  mentionQuery,
  resolveMentions,
  resolveEditedMentions,
} from "./mentions";
const alice = { name: "Alice Smith", pubkey: "a".repeat(64) };
const bob = { name: "Bob", pubkey: "b".repeat(64) };
const other = { name: "Alice Smith", pubkey: "c".repeat(64) };
const keys = (text: string, members = [alice, bob]) =>
  resolveMentions(text, members).map((ref) => ref.pubkey);

test("mentions use full names, longest ownership, punctuation and code exclusions", () => {
  assert.deepEqual(keys("@Alice Smith, thanks @Bob!"), [
    alice.pubkey,
    bob.pubkey,
  ]);
  assert.deepEqual(keys("@alice smith @Alice Smith"), [alice.pubkey]);
  assert.deepEqual(keys("@Alice Smith", [alice, { ...bob, name: "Alice" }]), [
    alice.pubkey,
  ]);
  for (const text of [
    "mail@Bob.com",
    "`@Bob`",
    "```\n@Bob\n```",
    "    @Bob",
    "@Bobby",
    "\\@Bob",
  ])
    assert.deepEqual(keys(text), []);
});

test("ambiguous typed names fail; picker labels select exactly one identity", () => {
  const members = [alice, other, bob];
  assert.throws(() => keys("@Alice Smith hi", members), /more than one member/);
  const label = mentionLabel(other, members, []);
  assert.equal(label, `Alice Smith (${other.pubkey})`);
  assert.deepEqual(
    resolveMentions(`@${label} hi`, members, [
      { pubkey: other.pubkey, displayName: label },
    ]).map((ref) => ref.pubkey),
    [other.pubkey],
  );
  assert.deepEqual(keys(`@Alice Smith (${other.pubkey})`, members), []);
});

test("selected identities survive renames and fail closed when membership disappears", () => {
  const selected = [{ pubkey: alice.pubkey, displayName: alice.name }];
  assert.deepEqual(
    resolveMentions(
      "@Alice Smith",
      [{ ...alice, name: "Renamed" }, other],
      selected,
    ).map((ref) => ref.pubkey),
    [alice.pubkey],
  );
  assert.throws(
    () => resolveMentions("@Alice Smith", [other], selected),
    /no longer a channel member/,
  );
  assert.deepEqual(resolveMentions("mention removed", [other], selected), []);
});

test("historical full-key labels require signed identity tags and do not capture a shorter alias", () => {
  const content = `@Alice Smith (${other.pubkey})`;
  assert.deepEqual(historicalMentions(content, [], [alice, other]), []);
  assert.deepEqual(historicalMentions(content, [other.pubkey], []), [
    { pubkey: other.pubkey, displayName: `Alice Smith (${other.pubkey})` },
  ]);
  assert.deepEqual(
    historicalMentions(
      "@Alice Smith",
      [alice.pubkey, other.pubkey],
      [alice, other],
    ),
    [],
  );
});

test("picker query supports spaces and caret insertion but not code or email", () => {
  assert.deepEqual(mentionQuery("Hello @Alice S", 14), {
    start: 6,
    query: "Alice S",
  });
  assert.equal(mentionQuery("alice@Bob", 9), null);
  assert.equal(mentionQuery("`@Bob`", 5), null);
  assert.equal(mentionQuery("```\n@Bob", 8), null);
  assert.deepEqual(mentionQuery("@Bo trailing", 3), { start: 0, query: "Bo" });
});

test("editing old unbound text cannot notify a new namesake", () => {
  const original = {
    content: "@Alice Smith original",
    pubkeys: [alice.pubkey],
  };
  const currentRoster = [other, bob];
  assert.deepEqual(
    resolveEditedMentions(original.content, currentRoster, [], original),
    [alice.pubkey],
  );
  assert.deepEqual(
    resolveEditedMentions(
      "@Alice Smith typo fixed",
      currentRoster,
      [],
      original,
    ),
    [],
  );
  const selected = [{ displayName: other.name, pubkey: other.pubkey }];
  assert.deepEqual(
    resolveEditedMentions(original.content, currentRoster, selected, original),
    [other.pubkey],
  );
  assert.deepEqual(
    resolveEditedMentions(
      "@Bob Jones newly added",
      currentRoster,
      [],
      original,
    ),
    [bob.pubkey],
  );
});
