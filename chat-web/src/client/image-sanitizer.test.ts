import assert from "node:assert/strict";
import test from "node:test";

import {
  sanitizeImageAttachment,
  stripGifMetadata,
  stripJpegMetadata,
  stripPngMetadata,
  stripWebpMetadata,
} from "./image-sanitizer";

const encoder = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function pngChunk(
  kind: string,
  payload: Uint8Array = new Uint8Array(),
): Uint8Array {
  const chunk = new Uint8Array(12 + payload.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, payload.length, false);
  chunk.set(encoder.encode(kind), 4);
  chunk.set(payload, 8);
  return chunk;
}

function webpChunk(kind: string, payload: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(8 + payload.length + (payload.length & 1));
  chunk.set(encoder.encode(kind), 0);
  new DataView(chunk.buffer).setUint32(4, payload.length, true);
  chunk.set(payload, 8);
  return chunk;
}

function webp(...chunks: Uint8Array[]): Uint8Array {
  const body = concat(...chunks);
  const header = new Uint8Array(12);
  header.set(encoder.encode("RIFF"), 0);
  new DataView(header.buffer).setUint32(4, body.length + 4, true);
  header.set(encoder.encode("WEBP"), 8);
  return concat(header, body);
}

function minimalGif(): Uint8Array {
  return new Uint8Array([
    ...encoder.encode("GIF89a"),
    0x02,
    0x00,
    0x02,
    0x00,
    0x80,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0xff,
    0xff,
    0xff,
    0x21,
    0xff,
    11,
    ...encoder.encode("NETSCAPE2.0"),
    3,
    1,
    0,
    0,
    0,
    0x21,
    0xf9,
    4,
    0,
    10,
    0,
    0,
    0,
    0x2c,
    0,
    0,
    0,
    0,
    2,
    0,
    2,
    0,
    0,
    2,
    2,
    0x44,
    0x01,
    0,
    0x3b,
  ]);
}

test("PNG sanitizer removes metadata and trailing bytes but preserves one Buzz snapshot", () => {
  const signature = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const snapshot = concat(
    encoder.encode("buzz_agent_snapshot"),
    new Uint8Array([0]),
    encoder.encode("payload"),
  );
  const dirty = concat(
    signature,
    pngChunk("IHDR", new Uint8Array(13)),
    pngChunk("tEXt", encoder.encode("Comment\0private")),
    pngChunk("pHYs", new Uint8Array(9)),
    pngChunk("tEXt", snapshot),
    pngChunk("tEXt", snapshot),
    pngChunk("sRGB", new Uint8Array([0])),
    pngChunk("IEND"),
    encoder.encode("trailing metadata"),
  );

  const sanitized = stripPngMetadata(dirty);
  const text = new TextDecoder().decode(sanitized);
  assert.ok(!text.includes("private"));
  assert.ok(!text.includes("pHYs"));
  assert.equal(text.match(/buzz_agent_snapshot/g)?.length, 1);
  assert.ok(text.includes("sRGB"));
  assert.ok(!text.includes("trailing metadata"));
});

test("GIF sanitizer preserves frames and canonical looping while removing metadata", () => {
  const clean = minimalGif();
  const comment = concat(
    new Uint8Array([0x21, 0xfe, 5]),
    encoder.encode("hello"),
    new Uint8Array([0]),
  );
  const foreign = concat(
    new Uint8Array([0x21, 0xff, 11]),
    encoder.encode("XMP DataXMP"),
    new Uint8Array([4]),
    encoder.encode("<x/>"),
    new Uint8Array([0]),
  );
  const dirty = concat(
    clean.subarray(0, 19),
    comment,
    foreign,
    clean.subarray(19),
    encoder.encode("tail"),
  );
  assert.deepEqual(stripGifMetadata(dirty), clean);
});

test("JPEG sanitizer keeps canonical color headers and removes private application segments", () => {
  const segment = (marker: number, payload: Uint8Array): Uint8Array => {
    const output = new Uint8Array(4 + payload.length);
    output.set([0xff, marker, 0, payload.length + 2], 0);
    output.set(payload, 4);
    return output;
  };
  const jfif = concat(
    encoder.encode("JFIF\0"),
    new Uint8Array([1, 1, 0, 0, 1, 0, 1, 0, 0]),
  );
  const dirty = concat(
    new Uint8Array([0xff, 0xd8]),
    segment(0xe0, jfif),
    segment(0xe1, encoder.encode("Exif\0\0private")),
    segment(0xe2, encoder.encode("ICC_PROFILE\0private")),
    segment(0xfe, encoder.encode("private comment")),
    segment(0xdb, new Uint8Array([1, 2, 3])),
    segment(0xda, new Uint8Array([1, 2])),
    new Uint8Array([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]),
    encoder.encode("trailing metadata"),
  );

  const sanitized = stripJpegMetadata(dirty);
  const text = new TextDecoder().decode(sanitized);
  assert.ok(text.includes("JFIF"));
  assert.ok(!text.includes("Exif"));
  assert.ok(!text.includes("ICC_PROFILE"));
  assert.ok(!text.includes("private comment"));
  assert.ok(!text.includes("trailing metadata"));
  assert.deepEqual(sanitized.subarray(-2), new Uint8Array([0xff, 0xd9]));
});

test("WebP sanitizer removes metadata, clears presence flags, and canonicalizes length", () => {
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x20 | 0x08 | 0x04;
  const dirty = concat(
    webp(
      webpChunk("VP8X", vp8x),
      webpChunk("EXIF", encoder.encode("private exif")),
      webpChunk("XMP ", encoder.encode("private xmp")),
      webpChunk("VP8L", new Uint8Array([1, 2, 3])),
    ),
    encoder.encode("trailing metadata"),
  );

  const sanitized = stripWebpMetadata(dirty);
  assert.equal(
    new DataView(sanitized.buffer).getUint32(4, true) + 8,
    sanitized.length,
  );
  assert.equal(sanitized[20] & (0x20 | 0x08 | 0x04), 0);
  const text = new TextDecoder().decode(sanitized);
  assert.ok(!text.includes("EXIF"));
  assert.ok(!text.includes("XMP "));
  assert.ok(!text.includes("trailing metadata"));
  assert.ok(text.includes("VP8L"));
});

test("animated images fail before upload when metadata removal would change appearance", async () => {
  const signature = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const animatedWithProfile = concat(
    signature,
    pngChunk("IHDR", new Uint8Array(13)),
    pngChunk("acTL", new Uint8Array(8)),
    pngChunk("iCCP", encoder.encode("profile")),
    pngChunk("IEND"),
  );
  const file = new File([new Uint8Array(animatedWithProfile)], "animated.png", {
    type: "image/png",
  });
  await assert.rejects(
    sanitizeImageAttachment(file, new AbortController().signal),
    /cannot be removed safely/,
  );
});
