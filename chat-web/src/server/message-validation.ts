import { verifyEvent } from "nostr-tools";

import type { NostrEvent } from "@/server/types";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_ID = /^[0-9a-f]{64}$/i;
const MESSAGE_KINDS = new Set([9, 45001, 45003]);

function tagValues(event: NostrEvent, key: string): string[] {
  return event.tags
    .filter((tag) => tag[0] === key && typeof tag[1] === "string")
    .map((tag) => tag[1]);
}

export function validateMessageEvent(
  sessionPubkey: string,
  event: NostrEvent,
  nowSeconds = Math.floor(Date.now() / 1000),
): void {
  if (!verifyEvent(event)) throw new Error("Message signature is invalid");
  if (event.pubkey !== sessionPubkey) {
    throw new Error("Message signer does not match the login session");
  }
  if (!MESSAGE_KINDS.has(event.kind))
    throw new Error("Event kind is not allowed");
  if (!event.content.trim()) throw new Error("Message cannot be empty");
  if (Buffer.byteLength(event.content, "utf8") > 64 * 1024) {
    throw new Error("Message is larger than 64 KiB");
  }
  if (Math.abs(nowSeconds - event.created_at) > 60) {
    throw new Error("Message timestamp is stale");
  }
  const channels = tagValues(event, "h");
  if (channels.length !== 1 || !UUID.test(channels[0])) {
    throw new Error("Message must target exactly one valid channel");
  }
  const references = event.tags.filter((tag) => tag[0] === "e");
  if (
    references.length > 2 ||
    references.some(
      (tag) =>
        !EVENT_ID.test(tag[1] ?? "") ||
        (tag[3] !== "root" && tag[3] !== "reply"),
    )
  ) {
    throw new Error("Message has invalid thread references");
  }
  const rootReferences = references.filter((tag) => tag[3] === "root");
  const replyReferences = references.filter((tag) => tag[3] === "reply");
  if (
    rootReferences.length > 1 ||
    replyReferences.length > 1 ||
    (references.length === 2 &&
      (rootReferences.length !== 1 ||
        replyReferences.length !== 1 ||
        rootReferences[0][1] === replyReferences[0][1])) ||
    (references.length === 1 && replyReferences.length !== 1)
  ) {
    throw new Error("Message has invalid NIP-10 thread markers");
  }
  const isReply = replyReferences.length === 1;
  if (event.kind === 45003 && !isReply) {
    throw new Error("Forum replies require a thread root");
  }
  if (event.kind === 45001 && isReply) {
    throw new Error("Forum topics cannot be replies");
  }
}
