import assert from "node:assert/strict";
import test from "node:test";

import {
  bytesToHex,
  deriveSas,
  deriveSessionId,
  deriveTranscriptHash,
  ecdhSharedSecret,
  hexToBytes,
} from "./pairing-crypto";

const sessionSecret = hexToBytes(
  "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
);
const sourcePrivate = hexToBytes(
  "7f4c11a9c9d1e3b5a7f2e4d6c8b0a2f4e6d8c0b2a4f6e8d0c2b4a6f8e0d2c4b5",
);
const sourcePublic =
  "199e64ca60662cb2d6e91d16cb065be51ad74a6ee5f8c5b0fdc53d246611ed9a";
const targetPublic =
  "89a9fa762105d0aee2b19678246fe7b823aabbc4f4bf691a1ce8a70fcd36d6e4";

test("NIP-AB derivations match the normative test vector", () => {
  const sessionId = deriveSessionId(sessionSecret);
  assert.equal(
    bytesToHex(sessionId),
    "fb357d0f8e8d5a5ba3b2a91cb18c119e1567b07ffa38cdebb73e68df78f5a380",
  );

  const shared = ecdhSharedSecret(sourcePrivate, targetPublic);
  assert.equal(
    bytesToHex(shared),
    "9b4b6d6990713d89d6d9982e506ee1bbcde6f05c54d9d2978696e8a7274d4408",
  );

  const sas = deriveSas(shared, sessionSecret);
  assert.equal(sas.code, "863346");
  assert.equal(
    bytesToHex(sas.input),
    "e8b03a329f3a0ac37fe7fbe929171e14b72812be67e33c5d6e193543c41798d3",
  );

  assert.equal(
    bytesToHex(
      deriveTranscriptHash(
        sessionId,
        sourcePublic,
        targetPublic,
        sas.input,
        sessionSecret,
      ),
    ),
    "d662818ff8911fc60a2d025f8b8b4756107104e85888dd202d28db5ca2cf28d3",
  );
});

test("NIP-AB derivations reject malformed public keys and secrets", () => {
  assert.throws(() => deriveSessionId(new Uint8Array(31)), /32 bytes/);
  assert.throws(
    () => ecdhSharedSecret(sourcePrivate, "A".repeat(64)),
    /Invalid pairing public key/,
  );
});
