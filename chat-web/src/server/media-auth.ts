import { verifyEvent } from "nostr-tools";

import type { NostrEvent } from "@/server/types";

const MEDIA_PATH = /^\/media\/[0-9a-f]{64}(?:\.[a-z0-9]{1,8}|\.thumb\.jpg)?$/;
const MEDIA_AUTH_KIND = 24_242;
const MEDIA_AUTH_LIFETIME_SECONDS = 600;

function asEvent(value: unknown): NostrEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Partial<NostrEvent>;
  if (
    typeof event.id !== "string" ||
    typeof event.pubkey !== "string" ||
    typeof event.created_at !== "number" ||
    typeof event.kind !== "number" ||
    !Array.isArray(event.tags) ||
    event.tags.some(
      (tag) =>
        !Array.isArray(tag) || tag.some((part) => typeof part !== "string"),
    ) ||
    typeof event.content !== "string" ||
    typeof event.sig !== "string"
  ) {
    return null;
  }
  return event as NostrEvent;
}

function singleTag(event: NostrEvent, name: string): string | null {
  const tags = event.tags.filter((tag) => tag[0] === name);
  return tags.length === 1 && typeof tags[0][1] === "string"
    ? tags[0][1]
    : null;
}

export function relayMediaTarget(relayHttpUrl: string, rawUrl: string): URL {
  const relay = new URL(relayHttpUrl);
  const target = new URL(rawUrl);
  if (
    target.origin !== relay.origin ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    !MEDIA_PATH.test(target.pathname)
  ) {
    throw new Error("Media URL is not a relay blob URL");
  }
  return target;
}

export function validateMediaAuthorization(
  authorization: string | null,
  expectedPubkey: string,
  target: URL,
  now = Math.floor(Date.now() / 1_000),
): NostrEvent {
  if (!authorization?.startsWith("Nostr ") || authorization.length > 24_000) {
    throw new Error("Media authorization is missing or invalid");
  }
  const token = authorization.slice(6);
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("Media authorization is missing or invalid");
  }
  let event: NostrEvent | null = null;
  try {
    const raw = Buffer.from(token, "base64url").toString("utf8");
    event = asEvent(JSON.parse(raw));
  } catch {
    // The generic error below intentionally avoids exposing parser details.
  }
  const expiration = event ? Number(singleTag(event, "expiration")) : 0;
  const server = event ? singleTag(event, "server") : null;
  if (
    !event ||
    event.kind !== MEDIA_AUTH_KIND ||
    event.pubkey !== expectedPubkey ||
    !verifyEvent(event) ||
    !Number.isSafeInteger(event.created_at) ||
    !event.content.trim() ||
    singleTag(event, "t") !== "get" ||
    !Number.isSafeInteger(expiration) ||
    expiration <= now ||
    expiration > event.created_at + MEDIA_AUTH_LIFETIME_SECONDS ||
    event.created_at > now + 5 ||
    event.created_at < now - MEDIA_AUTH_LIFETIME_SECONDS ||
    server?.toLowerCase() !== target.host.toLowerCase()
  ) {
    throw new Error("Media authorization is missing or invalid");
  }
  return event;
}
