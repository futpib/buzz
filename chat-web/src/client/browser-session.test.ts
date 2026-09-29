import assert from "node:assert/strict";
import test from "node:test";
import { getPublicKey, nip19, verifyEvent } from "nostr-tools";
import { restoreBrowserSession } from "./browser-session";
import {
  forgetCredential,
  storeCredential,
  loadSigningCredential,
} from "./identity";
import type { NostrEvent } from "@/server/types";

const secret = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const credential = { nsec: nip19.nsecEncode(secret), authTag: null };
const pubkey = getPublicKey(secret);

test("session renewal coalesces concurrent writes and sends only a signed public proof", async (t) => {
  await storeCredential(credential);
  const requests: { url: string; body: string }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit) => {
      requests.push({ url, body: String(options.body) });
      return Response.json(
        url.endsWith("/start")
          ? {
              attemptId: "attempt",
              challenge: "challenge",
              relayUrl: "wss://relay.test",
            }
          : { pubkey },
      );
    },
  );
  await Promise.all([
    restoreBrowserSession(pubkey),
    restoreBrowserSession(pubkey),
  ]);
  assert.equal(requests.length, 2);
  const body = JSON.parse(requests[1].body) as { event: NostrEvent };
  assert.equal(body.event.pubkey, pubkey);
  assert.equal(verifyEvent(body.event), true);
  assert.equal(JSON.stringify(requests).includes(credential.nsec), false);
  assert.deepEqual(await loadSigningCredential(pubkey), credential);
  await forgetCredential();
});

test("logout during the challenge prevents background session renewal", async (t) => {
  await storeCredential(credential);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    await forgetCredential();
    return Response.json({
      attemptId: "attempt",
      challenge: "challenge",
      relayUrl: "wss://relay.test",
    });
  });
  await assert.rejects(restoreBrowserSession(pubkey), /abort/i);
  assert.equal(calls, 1, "no authentication proof is sent after logout");
  assert.equal(await loadSigningCredential(), null);
});
