"use client";

const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_ALLOWED_ANCILLARY = new Set([
  "cHRM",
  "gAMA",
  "sBIT",
  "sRGB",
  "bKGD",
  "hIST",
  "tRNS",
  "sPLT",
  "acTL",
  "fcTL",
  "fdAT",
]);
const WEBP_ALLOWED_CHUNKS = new Set([
  "VP8 ",
  "VP8L",
  "VP8X",
  "ALPH",
  "ANIM",
  "ANMF",
]);
const WEBP_METADATA_FLAGS = 0x20 | 0x08 | 0x04;
const MAX_IMAGE_PIXELS = 25_000_000;
const textDecoder = new TextDecoder("ascii", { fatal: true });
const textEncoder = new TextEncoder();

type ImageInspection = {
  animated: boolean;
  hasColorProfile: boolean;
  orientation: number | null;
};

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Upload canceled", "AbortError");
}

function matches(
  bytes: Uint8Array,
  offset: number,
  expected: Uint8Array,
): boolean {
  return (
    offset >= 0 &&
    bytes.length - offset >= expected.length &&
    expected.every((value, index) => bytes[offset + index] === value)
  );
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return textDecoder.decode(bytes.subarray(offset, offset + length));
}

function readUint16(
  bytes: Uint8Array,
  offset: number,
  littleEndian: boolean,
): number {
  if (offset < 0 || bytes.length - offset < 2)
    throw new Error("Invalid image metadata");
  return littleEndian
    ? bytes[offset] | (bytes[offset + 1] << 8)
    : (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint32(
  bytes: Uint8Array,
  offset: number,
  littleEndian: boolean,
): number {
  if (offset < 0 || bytes.length - offset < 4)
    throw new Error("Invalid image metadata");
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
  return view.getUint32(0, littleEndian);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function exifOrientation(payload: Uint8Array): number | null {
  let tiffStart = 0;
  if (
    payload.length >= 6 &&
    ascii(payload, 0, 4) === "Exif" &&
    payload[4] === 0 &&
    payload[5] === 0
  ) {
    tiffStart = 6;
  }
  if (payload.length - tiffStart < 8) return null;
  const endian = ascii(payload, tiffStart, 2);
  const littleEndian = endian === "II";
  if (!littleEndian && endian !== "MM") return null;
  if (readUint16(payload, tiffStart + 2, littleEndian) !== 42) return null;
  const directory =
    tiffStart + readUint32(payload, tiffStart + 4, littleEndian);
  if (directory < tiffStart || payload.length - directory < 2) return null;
  const entries = readUint16(payload, directory, littleEndian);
  for (let index = 0; index < entries; index += 1) {
    const entry = directory + 2 + index * 12;
    if (payload.length - entry < 12) return null;
    if (
      readUint16(payload, entry, littleEndian) === 0x0112 &&
      readUint16(payload, entry + 2, littleEndian) === 3 &&
      readUint32(payload, entry + 4, littleEndian) === 1
    ) {
      return readUint16(payload, entry + 8, littleEndian);
    }
  }
  return null;
}

function isSnapshotText(payload: Uint8Array): boolean {
  return ["buzz_agent_snapshot", "buzz_team_snapshot"].some((keyword) => {
    const encoded = textEncoder.encode(keyword);
    return matches(payload, 0, encoded) && payload[encoded.length] === 0;
  });
}

function inspectPng(bytes: Uint8Array): ImageInspection {
  if (!matches(bytes, 0, PNG_SIGNATURE)) throw new Error("Invalid PNG image");
  let offset = PNG_SIGNATURE.length;
  let animated = false;
  let hasColorProfile = false;
  let orientation: number | null = null;
  let sawEnd = false;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) throw new Error("Invalid PNG image");
    const length = readUint32(bytes, offset, false);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.length) {
      throw new Error("Invalid PNG image");
    }
    const kind = ascii(bytes, offset + 4, 4);
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    if (kind === "acTL") animated = true;
    if (kind === "iCCP") hasColorProfile = true;
    if (kind === "eXIf") orientation = exifOrientation(payload);
    offset = end;
    if (kind === "IEND") {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd) throw new Error("PNG is missing IEND");
  return { animated, hasColorProfile, orientation };
}

export function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  inspectPng(bytes);
  const parts: Uint8Array[] = [PNG_SIGNATURE];
  let offset = PNG_SIGNATURE.length;
  let sawSnapshot = false;
  while (offset < bytes.length) {
    const length = readUint32(bytes, offset, false);
    const end = offset + 12 + length;
    const kind = ascii(bytes, offset + 4, 4);
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    const ancillary = (bytes[offset + 4] & 0x20) !== 0;
    const keepSnapshot =
      kind === "tEXt" && !sawSnapshot && isSnapshotText(payload);
    if (!ancillary || PNG_ALLOWED_ANCILLARY.has(kind) || keepSnapshot) {
      parts.push(bytes.subarray(offset, end));
      if (keepSnapshot) sawSnapshot = true;
    }
    offset = end;
    if (kind === "IEND") break;
  }
  return concatBytes(parts);
}

function gifSubBlocksEnd(bytes: Uint8Array, start: number): number {
  let offset = start;
  for (;;) {
    if (offset >= bytes.length) throw new Error("Invalid GIF image");
    const length = bytes[offset];
    offset += 1;
    if (length === 0) return offset;
    offset += length;
    if (offset > bytes.length) throw new Error("Invalid GIF image");
  }
}

export function stripGifMetadata(bytes: Uint8Array): Uint8Array {
  const header = ascii(bytes, 0, Math.min(6, bytes.length));
  if ((header !== "GIF87a" && header !== "GIF89a") || bytes.length < 13) {
    throw new Error("Invalid GIF image");
  }
  let offset = 13;
  if ((bytes[10] & 0x80) !== 0) {
    offset += 3 << ((bytes[10] & 0x07) + 1);
    if (offset > bytes.length) throw new Error("Invalid GIF image");
  }
  const parts = [bytes.subarray(0, offset)];
  for (;;) {
    const introducer = bytes[offset];
    if (introducer === 0x2c) {
      if (bytes.length - offset < 10) throw new Error("Invalid GIF image");
      let end = offset + 10;
      const packed = bytes[offset + 9];
      if ((packed & 0x80) !== 0) end += 3 << ((packed & 0x07) + 1);
      if (end >= bytes.length) throw new Error("Invalid GIF image");
      end = gifSubBlocksEnd(bytes, end + 1);
      parts.push(bytes.subarray(offset, end));
      offset = end;
      continue;
    }
    if (introducer === 0x21) {
      if (bytes.length - offset < 2) throw new Error("Invalid GIF image");
      const start = offset;
      const label = bytes[offset + 1];
      offset += 2;
      if (label === 0xf9) {
        if (
          bytes[offset] !== 4 ||
          bytes.length - offset < 6 ||
          bytes[offset + 5] !== 0
        ) {
          throw new Error("Invalid GIF image");
        }
        offset += 6;
        parts.push(bytes.subarray(start, offset));
      } else if (label === 0xff) {
        if (bytes[offset] !== 11 || bytes.length - offset < 12) {
          throw new Error("Invalid GIF image");
        }
        const application = ascii(bytes, offset + 1, 11);
        const dataStart = offset + 12;
        offset = gifSubBlocksEnd(bytes, dataStart);
        if (application === "NETSCAPE2.0" || application === "ANIMEXTS1.0") {
          if (
            bytes[dataStart] !== 3 ||
            bytes[dataStart + 1] !== 1 ||
            dataStart + 5 > bytes.length
          ) {
            throw new Error("Invalid GIF image");
          }
          parts.push(bytes.subarray(start, dataStart + 4), new Uint8Array([0]));
        }
      } else {
        offset = gifSubBlocksEnd(bytes, offset);
      }
      continue;
    }
    if (introducer === 0x3b) {
      parts.push(new Uint8Array([0x3b]));
      return concatBytes(parts);
    }
    throw new Error("Invalid GIF image");
  }
}

export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("Invalid JPEG image");
  }
  const parts = [bytes.subarray(0, 2)];
  let offset = 2;
  let inScan = false;
  while (offset < bytes.length) {
    if (inScan && bytes[offset] !== 0xff) {
      let end = offset + 1;
      while (end < bytes.length && bytes[end] !== 0xff) end += 1;
      parts.push(bytes.subarray(offset, end));
      offset = end;
      continue;
    }
    if (bytes[offset] !== 0xff) throw new Error("Invalid JPEG image");
    const markerStart = offset;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) throw new Error("Invalid JPEG image");
    const marker = bytes[offset];
    offset += 1;
    if (inScan && marker === 0x00) {
      parts.push(bytes.subarray(markerStart, offset));
      continue;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(bytes.subarray(markerStart, offset));
      continue;
    }
    if (marker === 0xd9) {
      parts.push(bytes.subarray(markerStart, offset));
      return concatBytes(parts);
    }
    if (marker === 0xd8 || bytes.length - offset < 2) {
      throw new Error("Invalid JPEG image");
    }
    const length = readUint16(bytes, offset, false);
    const end = offset + length;
    if (length < 2 || end > bytes.length) throw new Error("Invalid JPEG image");
    const payload = bytes.subarray(offset + 2, end);
    let keep = true;
    if (marker === 0xe0) {
      const thumbnailBytes =
        payload.length >= 14 ? 3 * payload[12] * payload[13] : -1;
      keep =
        payload.length >= 14 &&
        ascii(payload, 0, 5) === "JFIF\0" &&
        payload.length === 14 + thumbnailBytes;
    } else if (marker === 0xee) {
      keep = payload.length === 12 && ascii(payload, 0, 5) === "Adobe";
    } else if (
      (marker >= 0xe1 && marker <= 0xed) ||
      marker === 0xef ||
      marker === 0xfe
    ) {
      keep = false;
    }
    if (keep) parts.push(bytes.subarray(markerStart, end));
    offset = end;
    inScan = marker === 0xda;
  }
  throw new Error("JPEG is missing EOI");
}

function webpChunk(kind: string, payload: Uint8Array): Uint8Array {
  const output = new Uint8Array(8 + payload.length + (payload.length & 1));
  output.set(textEncoder.encode(kind), 0);
  new DataView(output.buffer).setUint32(4, payload.length, true);
  output.set(payload, 8);
  return output;
}

function stripWebpFrame(payload: Uint8Array): Uint8Array {
  if (payload.length < 16) throw new Error("Invalid WebP animation frame");
  const parts = [payload.subarray(0, 16)];
  let offset = 16;
  let sawAlpha = false;
  let sawImage = false;
  while (offset < payload.length) {
    if (payload.length - offset < 8)
      throw new Error("Invalid WebP animation frame");
    const kind = ascii(payload, offset, 4);
    const length = readUint32(payload, offset + 4, true);
    const start = offset + 8;
    const end = start + length + (length & 1);
    if (end > payload.length) throw new Error("Invalid WebP animation frame");
    const chunkPayload = payload.subarray(start, start + length);
    if (kind === "ALPH" && !sawAlpha && !sawImage) {
      parts.push(webpChunk(kind, chunkPayload));
      sawAlpha = true;
    } else if (kind === "VP8 " && !sawImage) {
      parts.push(webpChunk(kind, chunkPayload));
      sawImage = true;
    } else if (kind === "VP8L" && !sawAlpha && !sawImage) {
      parts.push(webpChunk(kind, chunkPayload));
      sawImage = true;
    } else if (kind === "ALPH" || kind === "VP8 " || kind === "VP8L") {
      throw new Error("Invalid WebP animation frame");
    }
    offset = end;
  }
  if (!sawImage) throw new Error("WebP animation frame is missing image data");
  return concatBytes(parts);
}

function inspectWebp(bytes: Uint8Array): ImageInspection {
  if (
    bytes.length < 12 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP"
  ) {
    throw new Error("Invalid WebP image");
  }
  const inputEnd = readUint32(bytes, 4, true) + 8;
  if (inputEnd < 12 || inputEnd > bytes.length)
    throw new Error("Invalid WebP image");
  let offset = 12;
  let animated = false;
  let hasColorProfile = false;
  let orientation: number | null = null;
  while (offset < inputEnd) {
    if (inputEnd - offset < 8) throw new Error("Invalid WebP image");
    const kind = ascii(bytes, offset, 4);
    const length = readUint32(bytes, offset + 4, true);
    const start = offset + 8;
    const end = start + length + (length & 1);
    if (end > inputEnd) throw new Error("Invalid WebP image");
    const payload = bytes.subarray(start, start + length);
    if (kind === "ANIM" || kind === "ANMF") animated = true;
    if (kind === "ICCP") hasColorProfile = true;
    if (kind === "EXIF") orientation = exifOrientation(payload);
    offset = end;
  }
  return { animated, hasColorProfile, orientation };
}

export function stripWebpMetadata(bytes: Uint8Array): Uint8Array {
  inspectWebp(bytes);
  const inputEnd = readUint32(bytes, 4, true) + 8;
  const chunks: Uint8Array[] = [];
  let offset = 12;
  while (offset < inputEnd) {
    const kind = ascii(bytes, offset, 4);
    const length = readUint32(bytes, offset + 4, true);
    const start = offset + 8;
    const end = start + length + (length & 1);
    if (WEBP_ALLOWED_CHUNKS.has(kind)) {
      let payload = bytes.subarray(start, start + length);
      if (kind === "VP8X") {
        if (payload.length === 0) throw new Error("Invalid WebP image");
        payload = new Uint8Array(payload);
        payload[0] &= ~WEBP_METADATA_FLAGS;
      } else if (kind === "ANMF") {
        payload = stripWebpFrame(payload);
      }
      chunks.push(webpChunk(kind, payload));
    }
    offset = end;
  }
  const body = concatBytes(chunks);
  const output = new Uint8Array(12 + body.length);
  output.set(textEncoder.encode("RIFF"), 0);
  new DataView(output.buffer).setUint32(4, body.length + 4, true);
  output.set(textEncoder.encode("WEBP"), 8);
  output.set(body, 12);
  return output;
}

async function encodeStaticImage(
  file: File,
  signal: AbortSignal,
): Promise<File> {
  checkAbort(signal);
  const mime = file.type.trim().toLowerCase();
  let source: CanvasImageSource;
  let width: number;
  let height: number;
  let release: () => void = () => undefined;
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file, {
      colorSpaceConversion: "default",
      imageOrientation: "from-image",
      premultiplyAlpha: "default",
    });
    source = bitmap;
    width = bitmap.width;
    height = bitmap.height;
    release = () => bitmap.close();
  } else {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    try {
      await image.decode();
    } catch {
      URL.revokeObjectURL(url);
      throw new Error("Image could not be decoded");
    }
    source = image;
    width = image.naturalWidth;
    height = image.naturalHeight;
    release = () => URL.revokeObjectURL(url);
  }
  try {
    checkAbort(signal);
    if (width <= 0 || height <= 0 || width * height > MAX_IMAGE_PIXELS) {
      throw new Error("Image dimensions are too large");
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { colorSpace: "srgb" });
    if (!context) throw new Error("Image could not be prepared");
    context.drawImage(source, 0, 0, width, height);
    const quality =
      mime === "image/jpeg" || mime === "image/webp" ? 0.95 : undefined;
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) =>
          result
            ? resolve(result)
            : reject(new Error("Image could not be encoded")),
        mime,
        quality,
      );
    });
    checkAbort(signal);
    const encoded = new Uint8Array(await blob.arrayBuffer());
    const canonical =
      mime === "image/jpeg"
        ? stripJpegMetadata(encoded)
        : mime === "image/png"
          ? stripPngMetadata(encoded)
          : mime === "image/webp"
            ? stripWebpMetadata(encoded)
            : encoded;
    return new File([new Uint8Array(canonical)], file.name, {
      type: mime,
      lastModified: file.lastModified,
    });
  } finally {
    release();
  }
}

export async function sanitizeImageAttachment(
  file: File,
  signal: AbortSignal,
): Promise<File> {
  const mime = file.type.trim().toLowerCase();
  if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime)) {
    return file;
  }
  checkAbort(signal);
  const bytes = new Uint8Array(await file.arrayBuffer());
  checkAbort(signal);
  let sanitized: Uint8Array | null = null;
  if (mime === "image/gif") {
    sanitized = stripGifMetadata(bytes);
  } else if (mime === "image/png") {
    const inspection = inspectPng(bytes);
    if (
      inspection.animated &&
      (inspection.hasColorProfile ||
        (inspection.orientation !== null && inspection.orientation >= 2))
    ) {
      throw new Error(
        "Animated PNG color or orientation metadata cannot be removed safely",
      );
    }
    if (
      !inspection.animated &&
      (inspection.hasColorProfile || inspection.orientation !== null)
    ) {
      return encodeStaticImage(file, signal);
    }
    sanitized = stripPngMetadata(bytes);
  } else if (mime === "image/webp") {
    const inspection = inspectWebp(bytes);
    if (
      inspection.animated &&
      (inspection.hasColorProfile ||
        (inspection.orientation !== null && inspection.orientation >= 2))
    ) {
      throw new Error(
        "Animated WebP color or orientation metadata cannot be removed safely",
      );
    }
    if (
      !inspection.animated &&
      (inspection.hasColorProfile || inspection.orientation !== null)
    ) {
      return encodeStaticImage(file, signal);
    }
    sanitized = stripWebpMetadata(bytes);
  } else {
    return encodeStaticImage(file, signal);
  }
  return new File([new Uint8Array(sanitized)], file.name, {
    type: mime,
    lastModified: file.lastModified,
  });
}
