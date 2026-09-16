import { verifyEvent } from "nostr-tools";

import type { NostrEvent } from "@/server/types";

const AUTH_FRESHNESS_SECONDS = 60;

function tagValues(event: NostrEvent, key: string): string[] {
  return event.tags
    .filter((tag) => tag[0] === key && typeof tag[1] === "string")
    .map((tag) => tag[1]);
}

export function validateAuthEvent(
  event: NostrEvent,
  challenge: string,
  relayUrl: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): void {
  if (!verifyEvent(event)) throw new Error("Login proof signature is invalid");
  if (event.kind !== 22242 || event.content !== "") {
    throw new Error("Login proof is not a NIP-42 authentication event");
  }
  if (
    tagValues(event, "challenge").length !== 1 ||
    tagValues(event, "challenge")[0] !== challenge
  ) {
    throw new Error("Login proof does not match this one-time challenge");
  }
  if (
    tagValues(event, "relay").length !== 1 ||
    tagValues(event, "relay")[0] !== relayUrl
  ) {
    throw new Error("Login proof is bound to a different relay");
  }
  if (Math.abs(nowSeconds - event.created_at) > AUTH_FRESHNESS_SECONDS) {
    throw new Error("Login proof is stale");
  }
}
