import { verifyEvent } from "nostr-tools";

import type { AuthSession } from "@/server/auth";
import type { NostrEvent, TypingIndicatorView } from "@/server/types";
import {
  parseTypingScope,
  TYPING_INDICATOR_KIND,
  TYPING_INDICATOR_TTL_MS,
} from "@/shared/typing";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function channelId(event: NostrEvent): string | null {
  const channels = event.tags
    .filter((tag) => tag[0] === "h" && typeof tag[1] === "string")
    .map((tag) => tag[1]);
  return channels.length === 1 && UUID.test(channels[0]) ? channels[0] : null;
}

export function validateTypingEvent(
  sessionPubkey: string,
  event: NostrEvent,
  nowSeconds = Math.floor(Date.now() / 1_000),
): void {
  if (!verifyEvent(event)) throw new Error("Typing signature is invalid");
  if (event.pubkey !== sessionPubkey) {
    throw new Error("Typing signer does not match the login session");
  }
  if (event.kind !== TYPING_INDICATOR_KIND) {
    throw new Error("Event kind is not a typing indicator");
  }
  if (event.content !== "") throw new Error("Typing content must be empty");
  if (Math.abs(nowSeconds - event.created_at) > 60) {
    throw new Error("Typing timestamp is stale");
  }
  if (!channelId(event)) {
    throw new Error("Typing must target exactly one valid channel");
  }
  if (!parseTypingScope(event.tags).valid) {
    throw new Error("Typing has invalid NIP-10 thread markers");
  }
}

export function projectTypingIndicator(
  event: NostrEvent,
  expectedChannelId: string,
  nowMs = Date.now(),
): TypingIndicatorView | null {
  const scope = parseTypingScope(event.tags);
  const createdAtMs = event.created_at * 1_000;
  if (
    event.kind !== TYPING_INDICATOR_KIND ||
    event.content !== "" ||
    channelId(event) !== expectedChannelId ||
    !scope.valid ||
    createdAtMs + TYPING_INDICATOR_TTL_MS <= nowMs ||
    createdAtMs > nowMs + TYPING_INDICATOR_TTL_MS
  ) {
    return null;
  }
  return {
    pubkey: event.pubkey.toLowerCase(),
    threadHeadId: scope.threadHeadId,
    createdAt: event.created_at,
  };
}

export async function publishTypingIndicator(
  session: AuthSession,
  event: NostrEvent,
): Promise<string> {
  validateTypingEvent(session.pubkey, event);
  await session.relay.publish(event);
  return event.id;
}
