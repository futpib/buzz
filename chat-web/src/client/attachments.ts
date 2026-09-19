"use client";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import {
  encodeNostrAuthorization,
  makeMediaUploadAuthEvent,
  type BrowserCredential,
} from "@/client/identity";
import {
  attachmentSizeLimit,
  type BlobDescriptor,
  parseBlobDescriptor,
} from "@/shared/attachments";

const HASH_CHUNK_BYTES = 4 * 1024 * 1024;
let uploadServerRequest: Promise<string> | null = null;

export class AttachmentUploadError extends Error {
  constructor(
    message: string,
    readonly loginRequired = false,
  ) {
    super(message);
    this.name = "AttachmentUploadError";
  }
}

async function uploadServer(): Promise<string> {
  if (uploadServerRequest) return uploadServerRequest;
  uploadServerRequest = fetch("/api/upload", { cache: "no-store" })
    .then(async (response) => {
      const body = (await response.json().catch(() => null)) as {
        error?: unknown;
        loginRequired?: unknown;
        server?: unknown;
      } | null;
      if (!response.ok || typeof body?.server !== "string") {
        throw new AttachmentUploadError(
          typeof body?.error === "string"
            ? body.error
            : "Upload service is unavailable",
          body?.loginRequired === true,
        );
      }
      return body.server;
    })
    .catch((error) => {
      uploadServerRequest = null;
      throw error;
    });
  return uploadServerRequest;
}

export async function hashAttachment(
  file: File,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
): Promise<string> {
  const digest = sha256.create();
  for (let offset = 0; offset < file.size; offset += HASH_CHUNK_BYTES) {
    if (signal.aborted) throw new DOMException("Upload canceled", "AbortError");
    const chunk = file.slice(offset, offset + HASH_CHUNK_BYTES);
    digest.update(new Uint8Array(await chunk.arrayBuffer()));
    onProgress(Math.min(1, (offset + chunk.size) / file.size));
  }
  return bytesToHex(digest.digest());
}

export async function uploadAttachment(
  file: File,
  credential: BrowserCredential,
  signal: AbortSignal,
  onPhase: (phase: "preparing" | "uploading", progress: number) => void,
): Promise<BlobDescriptor> {
  const mime = file.type.trim().toLowerCase() || "application/octet-stream";
  if (file.size <= 0) throw new Error("Empty files cannot be attached");
  const limit = attachmentSizeLimit(mime);
  if (file.size > limit) {
    throw new Error(
      `File is larger than ${Math.floor(limit / (1024 * 1024))} MB`,
    );
  }
  onPhase("preparing", 0);
  const hash = await hashAttachment(file, signal, (progress) =>
    onPhase("preparing", progress),
  );
  const server = await uploadServer();
  const authorization = encodeNostrAuthorization(
    makeMediaUploadAuthEvent(credential, server, hash, mime),
  );

  const descriptor = await new Promise<BlobDescriptor>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    signal.addEventListener("abort", abort, { once: true });
    request.open("POST", "/api/upload");
    request.setRequestHeader("Content-Type", mime);
    request.setRequestHeader("X-SHA-256", hash);
    request.setRequestHeader("X-Buzz-Media-Authorization", authorization);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onPhase("uploading", event.loaded / event.total);
      } else {
        onPhase("uploading", 0);
      }
    };
    request.onerror = () => reject(new Error("Media relay is unavailable"));
    request.onabort = () =>
      reject(new DOMException("Upload canceled", "AbortError"));
    request.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(request.responseText);
      } catch {
        // The stable fallback below handles a non-JSON response.
      }
      if (request.status < 200 || request.status >= 300) {
        const errorBody = body as {
          error?: unknown;
          loginRequired?: unknown;
        } | null;
        reject(
          new AttachmentUploadError(
            typeof errorBody?.error === "string"
              ? errorBody.error
              : "Attachment was not uploaded",
            errorBody?.loginRequired === true,
          ),
        );
        return;
      }
      try {
        resolve(parseBlobDescriptor(body));
      } catch (error) {
        reject(error);
      }
    };
    onPhase("uploading", 0);
    request.send(file);
  });

  if (descriptor.sha256 !== hash || descriptor.size !== file.size) {
    throw new Error("Upload response does not match the selected file");
  }
  return descriptor;
}
