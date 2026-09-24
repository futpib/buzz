import { verifyEvent } from "nostr-tools";

import type { NostrEvent } from "@/server/types";

const APP_DATA_KIND = 30_078;
const FIXED_TAGS = new Set([
  "channel-mutes",
  "channel-sections",
  "channel-sort",
  "channel-stars",
]);

export function isAllowedNavigationDTag(value: string): boolean {
  if (FIXED_TAGS.has(value)) return true;
  if (!value.startsWith("read-state:")) return false;
  const slot = value.slice("read-state:".length);
  return (
    slot.length > 0 &&
    slot.length <= 64 &&
    [...slot].every((character) => character.charCodeAt(0) <= 0x7f)
  );
}

export function validateNavigationAppDataEvent(
  sessionPubkey: string,
  event: NostrEvent,
  nowSeconds = Math.floor(Date.now() / 1_000),
): void {
  if (!verifyEvent(event)) throw new Error("Preference signature is invalid");
  if (event.pubkey !== sessionPubkey) {
    throw new Error("Preference signer does not match the login session");
  }
  if (event.kind !== APP_DATA_KIND) {
    throw new Error("Preference event kind is not allowed");
  }
  if (!event.content || Buffer.byteLength(event.content, "utf8") > 128 * 1024) {
    throw new Error("Preference payload is invalid");
  }
  if (Math.abs(nowSeconds - event.created_at) > 300) {
    throw new Error("Preference timestamp is stale");
  }
  const dTags = event.tags.filter((tag) => tag[0] === "d");
  const tTags = event.tags.filter((tag) => tag[0] === "t");
  if (
    dTags.length !== 1 ||
    dTags[0].length !== 2 ||
    !isAllowedNavigationDTag(dTags[0][1] ?? "")
  ) {
    throw new Error("Preference d-tag is invalid");
  }
  const dTag = dTags[0][1];
  const expectedTopic = dTag.startsWith("read-state:") ? "read-state" : dTag;
  if (
    tTags.length !== 1 ||
    tTags[0].length !== 2 ||
    tTags[0][1] !== expectedTopic
  ) {
    throw new Error("Preference topic is invalid");
  }
  if (event.tags.some((tag) => !["auth", "d", "t"].includes(tag[0]))) {
    throw new Error("Preference contains an unsupported tag");
  }
}
