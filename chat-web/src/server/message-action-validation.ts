import { verifyEvent } from "nostr-tools";

import type { NostrEvent } from "@/server/types";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_ID = /^[0-9a-f]{64}$/i;
const ACTION_KINDS = new Set([5, 7, 40_003, 40_004]);

function matchingTags(event: NostrEvent, name: string): string[][] {
  return event.tags.filter((tag) => tag[0] === name);
}

export function validateMessageActionEvent(
  sessionPubkey: string,
  event: NostrEvent,
  nowSeconds = Math.floor(Date.now() / 1_000),
): void {
  if (!verifyEvent(event)) {
    throw new Error("Message action signature is invalid");
  }
  if (event.pubkey !== sessionPubkey) {
    throw new Error("Message action signer does not match the login session");
  }
  if (!ACTION_KINDS.has(event.kind)) {
    throw new Error("Event kind is not a message action");
  }
  if (Math.abs(nowSeconds - event.created_at) > 60) {
    throw new Error("Message action timestamp is stale");
  }

  const targets = matchingTags(event, "e");
  if (
    targets.length !== 1 ||
    targets[0].length !== 2 ||
    !EVENT_ID.test(targets[0][1] ?? "")
  ) {
    throw new Error("Message action must target exactly one event");
  }
  const channels = matchingTags(event, "h");
  if (channels.some((tag) => tag.length !== 2 || !UUID.test(tag[1] ?? ""))) {
    throw new Error("Message action channel is invalid");
  }

  if (event.kind === 7) {
    const emoji = event.content.trim();
    if (!emoji || [...emoji].length > 64) {
      throw new Error("Reaction emoji is invalid");
    }
    if (channels.length !== 0) {
      throw new Error("Reaction must use the canonical target-only shape");
    }
    return;
  }

  if (event.kind === 40_004) {
    if (event.content !== "" || channels.length !== 1) {
      throw new Error(
        "Pin must have empty content and exactly one valid channel",
      );
    }
    return;
  }

  if (event.kind === 40_003) {
    if (!event.content.trim()) {
      throw new Error("Edited message cannot be empty");
    }
    if (Buffer.byteLength(event.content, "utf8") > 64 * 1_024) {
      throw new Error("Edited message is larger than 64 KiB");
    }
    if (channels.length !== 1) {
      throw new Error("Edit must target exactly one valid channel");
    }
    return;
  }

  if (event.content !== "") throw new Error("Deletion content must be empty");
  if (channels.length > 1) throw new Error("Deletion channel is invalid");
}
