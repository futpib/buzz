import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// Match Desktop's plaintext budget, including JSON framing. This also stays
// inside legacy NIP-44 v2 implementations and the BFF/relay ciphertext limits.
export const READ_STATE_MAX_PLAINTEXT_BYTES = 32_768;
const MAX_SLOTS = 128;
const encoder = new TextEncoder();

/** Split read markers without discarding local history or exceeding wire limits. */
export function readStatePayloads(
  clientId: string,
  contexts: Record<string, number>,
) {
  const makeValue = () => ({
    v: 1,
    client_id: clientId,
    contexts: {} as Record<string, number>,
  });
  const values = [makeValue()];
  const emptyBytes = encoder.encode(JSON.stringify(values[0])).length;
  let bytes = emptyBytes;
  let count = 0;
  for (const [key, timestamp] of Object.entries(contexts).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const entryBytes =
      encoder.encode(JSON.stringify({ [key]: timestamp })).length - 2;
    if (emptyBytes + entryBytes > READ_STATE_MAX_PLAINTEXT_BYTES) {
      throw new Error("A saved read marker is too large to sync");
    }
    if (bytes + entryBytes + (count ? 1 : 0) > READ_STATE_MAX_PLAINTEXT_BYTES) {
      if (values.length >= MAX_SLOTS) {
        throw new Error(
          "Saved read history exceeds the sync capacity; local history is preserved",
        );
      }
      values.push(makeValue());
      bytes = emptyBytes;
      count = 0;
    }
    Object.defineProperty(values[values.length - 1].contexts, key, {
      value: timestamp,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    bytes += entryBytes + (count ? 1 : 0);
    count++;
  }
  // Keep the original coordinate for existing queues. Extra coordinates are
  // stable across reloads and remain under the protocol's 64-byte slot limit,
  // even when the original client id already uses the whole limit.
  const slotPrefix = `web-${bytesToHex(sha256(encoder.encode(clientId))).slice(0, 40)}`;
  return values.map((value, index) => ({
    coordinate: `read-state:${index === 0 ? clientId : `${slotPrefix}-${index}`}`,
    topic: "read-state",
    value,
  }));
}
