"use client";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  utf8ToBytes,
} from "@noble/hashes/utils.js";

const SESSION_ID_INFO = utf8ToBytes("nostr-pair-session-id");
const SAS_INFO = utf8ToBytes("nostr-pair-sas-v1");
const TRANSCRIPT_INFO = utf8ToBytes("nostr-pair-transcript-v1");

export { bytesToHex, hexToBytes };

export function deriveSessionId(sessionSecret: Uint8Array): Uint8Array {
  if (sessionSecret.length !== 32) {
    throw new Error("Pairing session secret must be 32 bytes");
  }
  return hkdf(sha256, sessionSecret, new Uint8Array(), SESSION_ID_INFO, 32);
}

export function ecdhSharedSecret(
  privateKey: Uint8Array,
  publicKeyHex: string,
): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(publicKeyHex)) {
    throw new Error("Invalid pairing public key");
  }
  const compressed = hexToBytes(`02${publicKeyHex}`);
  return secp256k1.getSharedSecret(privateKey, compressed).subarray(1, 33);
}

export function deriveSas(
  ecdhShared: Uint8Array,
  sessionSecret: Uint8Array,
): { code: string; input: Uint8Array } {
  const input = hkdf(sha256, ecdhShared, sessionSecret, SAS_INFO, 32);
  const value = new DataView(
    input.buffer,
    input.byteOffset,
    input.byteLength,
  ).getUint32(0, false);
  return { code: String(value % 1_000_000).padStart(6, "0"), input };
}

export function deriveTranscriptHash(
  sessionId: Uint8Array,
  sourcePubkeyHex: string,
  targetPubkeyHex: string,
  sasInput: Uint8Array,
  sessionSecret: Uint8Array,
): Uint8Array {
  const transcript = concatBytes(
    sessionId,
    hexToBytes(sourcePubkeyHex),
    hexToBytes(targetPubkeyHex),
    sasInput,
  );
  return hkdf(sha256, transcript, sessionSecret, TRANSCRIPT_INFO, 32);
}

export function constantTimeEqual(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}
