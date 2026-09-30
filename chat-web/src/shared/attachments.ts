export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/** Recognize video URLs in both legacy image Markdown and attachment links. */
export function isVideoAttachmentUrl(src: string): boolean {
  try {
    const url = new URL(src, "https://relative.invalid");
    return (
      /^https?:$/.test(url.protocol) &&
      /\.(?:mp4|webm|ogv|m4v)$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

const HASH = /^[0-9a-f]{64}$/;
const CANONICAL_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export type BlobDescriptor = {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded: number;
  dim?: string;
  blurhash?: string;
  thumb?: string;
  duration?: number;
};

export type MessageAttachment = BlobDescriptor & {
  filename: string;
};

export function isCanonicalImageMime(mime: string): boolean {
  return CANONICAL_IMAGE_MIME.has(mime.toLowerCase());
}

export function attachmentSizeLimit(mime: string): number {
  if (mime.toLowerCase() === "video/mp4") return MAX_VIDEO_BYTES;
  if (isCanonicalImageMime(mime)) return MAX_IMAGE_BYTES;
  return MAX_FILE_BYTES;
}

export function sanitizeAttachmentFilename(filename: string): string {
  const basename = filename.split(/[\\/]/).at(-1)?.trim() ?? "";
  let safe = "";
  let byteLength = 0;
  for (const character of basename) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) continue;
    const characterBytes = new TextEncoder().encode(character).byteLength;
    if (byteLength + characterBytes > 255) break;
    safe += character;
    byteLength += characterBytes;
  }
  return safe || "attachment";
}

function escapeMarkdownLabel(label: string): string {
  return label
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

export function attachmentMarkdown(attachment: MessageAttachment): string {
  const label = escapeMarkdownLabel(attachment.filename);
  return isCanonicalImageMime(attachment.type)
    ? `![${label}](${attachment.url})`
    : `[${label}](${attachment.url})`;
}

export function messageContentWithAttachments(
  content: string,
  attachments: MessageAttachment[],
): string {
  return [content.trim(), ...attachments.map(attachmentMarkdown)]
    .filter(Boolean)
    .join("\n\n");
}

export function attachmentImetaTag(attachment: MessageAttachment): string[] {
  const tag = [
    "imeta",
    `url ${attachment.url}`,
    `m ${attachment.type}`,
    `x ${attachment.sha256}`,
    `size ${attachment.size}`,
  ];
  if (attachment.dim) tag.push(`dim ${attachment.dim}`);
  if (attachment.blurhash) tag.push(`blurhash ${attachment.blurhash}`);
  if (attachment.thumb) tag.push(`thumb ${attachment.thumb}`);
  if (attachment.duration !== undefined) {
    tag.push(`duration ${attachment.duration}`);
  }
  tag.push(`filename ${sanitizeAttachmentFilename(attachment.filename)}`);
  return tag;
}

export function parseBlobDescriptor(value: unknown): BlobDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Upload response is invalid");
  }
  const descriptor = value as Partial<BlobDescriptor>;
  if (
    typeof descriptor.url !== "string" ||
    typeof descriptor.sha256 !== "string" ||
    !HASH.test(descriptor.sha256) ||
    !Number.isSafeInteger(descriptor.size) ||
    (descriptor.size ?? 0) <= 0 ||
    typeof descriptor.type !== "string" ||
    !/^[^\s/]+\/[^\s/]+$/.test(descriptor.type) ||
    !Number.isSafeInteger(descriptor.uploaded)
  ) {
    throw new Error("Upload response is invalid");
  }
  for (const key of ["dim", "blurhash", "thumb"] as const) {
    if (descriptor[key] !== undefined && typeof descriptor[key] !== "string") {
      throw new Error("Upload response is invalid");
    }
  }
  if (
    descriptor.duration !== undefined &&
    (typeof descriptor.duration !== "number" ||
      !Number.isFinite(descriptor.duration) ||
      descriptor.duration <= 0)
  ) {
    throw new Error("Upload response is invalid");
  }
  return descriptor as BlobDescriptor;
}

export function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
