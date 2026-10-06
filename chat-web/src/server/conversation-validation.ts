import { verifyEvent } from "nostr-tools";
import type { NostrEvent } from "@/server/types";
import {
  conversationCommand,
  type ConversationAction,
} from "@/shared/conversations";

export function validateConversationEvent(
  pubkey: string,
  input: ConversationAction,
  event: NostrEvent,
  now = Math.floor(Date.now() / 1000),
) {
  if (!verifyEvent(event) || event.pubkey !== pubkey)
    throw new Error("Conversation signer does not match the login session");
  if (Math.abs(now - event.created_at) > 60)
    throw new Error("Conversation request expired; try again");
  const command = conversationCommand(input);
  const tags = event.tags.filter((tag) => tag[0] !== "auth");
  if (
    event.kind !== command.kind ||
    event.content !== "" ||
    JSON.stringify(tags) !== JSON.stringify(command.tags)
  )
    throw new Error("Conversation command does not match the request");
}

export function dmChannelFromAck(message: string): string | null {
  try {
    const parsed = JSON.parse(message.replace(/^response:/, ""));
    return typeof parsed.channel_id === "string" ? parsed.channel_id : null;
  } catch {
    return null;
  }
}
