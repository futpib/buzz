import assert from "node:assert/strict";
import test from "node:test";

import {
  attachmentImetaTag,
  attachmentMarkdown,
  attachmentSizeLimit,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  messageContentWithAttachments,
  parseBlobDescriptor,
  sanitizeAttachmentFilename,
} from "./attachments";

const descriptor = {
  url: `https://relay.example/media/${"a".repeat(64)}.pdf`,
  sha256: "a".repeat(64),
  size: 1234,
  type: "application/pdf",
  uploaded: 1_700_000_000,
  filename: "Q3 [final].pdf",
};

test("attachment helpers preserve canonical metadata and safe markdown", () => {
  assert.equal(
    attachmentMarkdown(descriptor),
    `[Q3 \\[final\\].pdf](${descriptor.url})`,
  );
  assert.equal(
    messageContentWithAttachments("Review this", [descriptor]),
    `Review this\n\n[Q3 \\[final\\].pdf](${descriptor.url})`,
  );
  assert.deepEqual(attachmentImetaTag(descriptor), [
    "imeta",
    `url ${descriptor.url}`,
    "m application/pdf",
    `x ${"a".repeat(64)}`,
    "size 1234",
    "filename Q3 [final].pdf",
  ]);
});

test("attachment helpers sanitize filenames and apply media size limits", () => {
  assert.equal(
    sanitizeAttachmentFilename("../unsafe\\report\u0000.pdf"),
    "report.pdf",
  );
  assert.equal(attachmentSizeLimit("image/png"), MAX_IMAGE_BYTES);
  assert.equal(attachmentSizeLimit("video/mp4"), MAX_VIDEO_BYTES);
  assert.equal(attachmentSizeLimit("application/pdf"), MAX_FILE_BYTES);
});

test("upload descriptors are structurally validated", () => {
  assert.deepEqual(parseBlobDescriptor(descriptor), descriptor);
  assert.throws(
    () => parseBlobDescriptor({ ...descriptor, sha256: "not-a-hash" }),
    /invalid/,
  );
  assert.throws(
    () => parseBlobDescriptor({ ...descriptor, size: 0 }),
    /invalid/,
  );
});
