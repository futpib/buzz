const INLINE_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export function isInlineImageMime(type: string): boolean {
  return INLINE_IMAGE_MIME_TYPES.has(type.toLowerCase());
}

export function isInlineVideoMime(type: string): boolean {
  return type.toLowerCase() === "video/mp4";
}
