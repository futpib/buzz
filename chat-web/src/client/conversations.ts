"use client";
import {
  loadSigningCredential,
  makeConversationEvent,
  signingIdentitySignal,
} from "@/client/identity";
import { restoreBrowserSession, responseError } from "@/client/browser-session";
import {
  conversationCommand,
  type ConversationAction,
} from "@/shared/conversations";
export type ConversationResult = {
  accepted: boolean;
  channelId: string | null;
  ready: boolean;
};
export async function changeConversation(
  pubkey: string,
  input: ConversationAction,
): Promise<ConversationResult> {
  const signal = AbortSignal.any([
    signingIdentitySignal(),
    AbortSignal.timeout(60_000),
  ]);
  const credential = await loadSigningCredential(pubkey);
  signal.throwIfAborted();
  if (!credential) throw new Error("Sign in again to manage conversations");
  const event = makeConversationEvent(credential, conversationCommand(input));
  const request = () =>
    fetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input, event }),
      signal,
    });
  let response = await request();
  if (response.status === 401) {
    await restoreBrowserSession(pubkey);
    signal.throwIfAborted();
    response = await request();
  }
  if (!response.ok)
    throw new Error(
      await responseError(response, "Conversation could not be changed"),
    );
  signal.throwIfAborted();
  return (await response.json()) as ConversationResult;
}
export function newChannelId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
