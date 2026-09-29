import assert from "node:assert/strict";
import test from "node:test";
import { getPublicKey, nip19 } from "nostr-tools";
import { validateNavigationAppDataEvent } from "../server/navigation-validation";
import { decryptOwnAppDataEvent, makeEncryptedAppDataEvent } from "./identity";
import {
  readStatePayloads,
  READ_STATE_MAX_PLAINTEXT_BYTES,
} from "./read-state-payload";

const secret = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const credential = { nsec: nip19.nsecEncode(secret), authTag: null };
const pubkey = getPublicKey(secret);

test("oversized legacy read history round-trips in valid encrypted slots without losing markers", () => {
  const clientId = "x".repeat(64);
  const contexts = Object.fromEntries(
    Array.from({ length: 5_000 }, (_, i) => [
      `${i % 2 ? "thread" : "msg"}:${i.toString(16).padStart(64, "0")}`,
      1_700_000_000 + i,
    ]),
  );
  contexts.channel = 1_700_000_000;
  const original = structuredClone(contexts);
  const legacy = makeEncryptedAppDataEvent(
    credential,
    {
      coordinate: `read-state:${clientId}`,
      topic: "read-state",
      value: { v: 1, client_id: clientId, contexts },
    },
    100,
  );
  assert.ok(legacy.content.length > 128 * 1024);
  assert.throws(
    () => validateNavigationAppDataEvent(pubkey, legacy, 100),
    /payload/,
  );

  const slots = readStatePayloads(clientId, contexts);
  assert.ok(slots.length > 1);
  assert.equal(slots[0].coordinate, `read-state:${clientId}`);
  const recovered = {};
  for (const slot of slots) {
    assert.ok(
      Buffer.byteLength(JSON.stringify(slot.value)) <=
        READ_STATE_MAX_PLAINTEXT_BYTES,
    );
    const event = makeEncryptedAppDataEvent(credential, slot, 100);
    // Go through JSON, just like HTTP, without nostr-tools' verified symbol.
    validateNavigationAppDataEvent(
      pubkey,
      JSON.parse(JSON.stringify(event)),
      100,
    );
    const value = decryptOwnAppDataEvent(credential, event) as {
      contexts: Record<string, number>;
    };
    Object.assign(recovered, value.contexts);
  }
  assert.deepEqual(recovered, original);
  assert.deepEqual(contexts, original);
  assert.deepEqual(
    readStatePayloads(
      clientId,
      Object.fromEntries(Object.entries(contexts).reverse()),
    ),
    slots,
  );
});

test("payload byte accounting handles escaped and multibyte keys at slot boundaries", () => {
  const contexts = Object.fromEntries(
    Array.from({ length: 700 }, (_, i) => [`${i}:"\\\n${"🦊".repeat(30)}`, i]),
  );
  const slots = readStatePayloads("unicode", contexts);
  assert.ok(slots.length > 1);
  assert.deepEqual(
    Object.assign({}, ...slots.map((slot) => slot.value.contexts)),
    contexts,
  );
  for (const slot of slots) {
    assert.ok(
      Buffer.byteLength(JSON.stringify(slot.value)) <=
        READ_STATE_MAX_PLAINTEXT_BYTES,
    );
  }
  assert.equal(
    readStatePayloads("empty", {})[0].coordinate,
    "read-state:empty",
  );
  assert.throws(
    () => readStatePayloads("large", { ["x".repeat(32_768)]: 1 }),
    /marker is too large/,
  );
});

test("exceeding the bounded slot capacity fails without modifying saved history", () => {
  const contexts = Object.fromEntries(
    Array.from({ length: 129 }, (_, i) => [`${i}:${"x".repeat(30_000)}`, i]),
  );
  const original = structuredClone(contexts);
  assert.throws(() => readStatePayloads("capacity", contexts), /capacity/);
  assert.deepEqual(contexts, original);
});
