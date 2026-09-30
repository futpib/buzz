import assert from "node:assert/strict";
import test from "node:test";
import { nip19, verifyEvent } from "nostr-tools";
import { storeCredential, forgetCredential } from "./identity";
import { loadProtectedVideo } from "./video-media";
import { MAX_VIDEO_BYTES, isVideoAttachmentUrl } from "../shared/attachments";

const credential = {
  nsec: nip19.nsecEncode(Uint8Array.from({ length: 32 }, (_, i) => i + 1)),
  authTag: null,
};
const target = new URL(`https://relay.example/media/${"a".repeat(64)}.mp4`);

test("protected video uses signed proxy authentication and preserves video MIME", async (t) => {
  await storeCredential(credential);
  t.after(forgetCredential);
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(
      url,
      `/api/media?${new URLSearchParams({ url: target.href })}`,
    );
    const authorization =
      new Headers(init.headers).get("X-Buzz-Media-Authorization") ?? "";
    const event = JSON.parse(
      Buffer.from(authorization.slice("Nostr ".length), "base64").toString(),
    );
    assert.equal(verifyEvent(event), true);
    assert.equal(event.kind, 24_242);
    assert.ok(
      event.tags.some(
        (tag: string[]) => tag[0] === "server" && tag[1] === target.host,
      ),
    );
    assert.equal(JSON.stringify(init).includes(credential.nsec), false);
    return new Response("video bytes", {
      headers: { "Content-Type": "video/mp4" },
    });
  });
  const blob = await loadProtectedVideo(target, new AbortController().signal);
  assert.equal(blob.type, "video/mp4");
  assert.equal(await blob.text(), "video bytes");
});

test("protected video rejects non-video, oversized and failed responses", async (t) => {
  await storeCredential(credential);
  t.after(forgetCredential);
  for (const [response, expected] of [
    [
      new Response("image", { headers: { "Content-Type": "image/png" } }),
      /not a video/,
    ],
    [
      new Response("large", {
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(MAX_VIDEO_BYTES + 1),
        },
      }),
      /size limit/,
    ],
    [
      Response.json({ error: "Access denied" }, { status: 403 }),
      /Access denied/,
    ],
  ] as const) {
    const mocked = t.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(
      loadProtectedVideo(target, new AbortController().signal),
      expected,
    );
    mocked.mock.restore();
  }
});

test("video URL classification uses the path and excludes executable schemes", () => {
  assert.equal(isVideoAttachmentUrl(target.href), true);
  assert.equal(
    isVideoAttachmentUrl("https://example.com/clip.MP4?token=1#t=5"),
    true,
  );
  assert.equal(
    isVideoAttachmentUrl("https://example.com/photo.png?name=clip.mp4"),
    false,
  );
  assert.equal(isVideoAttachmentUrl("javascript:clip.mp4"), false);
});

test("protected video renews an expired session before retrying the same media", async (t) => {
  await storeCredential(credential);
  t.after(forgetCredential);
  const urls: string[] = [];
  let mediaCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(url);
    if (url === "/api/auth/start")
      return Response.json({
        attemptId: "attempt",
        challenge: "challenge",
        relayUrl: "wss://relay.example",
      });
    if (url === "/api/auth/session") return Response.json({});
    if (mediaCalls++ === 0)
      return Response.json({ error: "Login required" }, { status: 401 });
    return new Response("video", { headers: { "Content-Type": "video/mp4" } });
  });
  const blob = await loadProtectedVideo(target, new AbortController().signal);
  assert.equal(blob.type, "video/mp4");
  assert.deepEqual(urls.slice(1, 3), ["/api/auth/start", "/api/auth/session"]);
  assert.equal(urls[0], urls[3]);
  assert.equal(mediaCalls, 2);
});
