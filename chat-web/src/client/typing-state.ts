"use client";

import type { ChannelSnapshot, TypingIndicatorView } from "@/server/types";
import { TYPING_INDICATOR_TTL_MS } from "@/shared/typing";

export type ClientTypingEntry = TypingIndicatorView & {
  expiresAt: number;
};

function key(entry: Pick<ClientTypingEntry, "pubkey" | "threadHeadId">) {
  return `${entry.pubkey}\u0000${entry.threadHeadId ?? ""}`;
}

export function pruneTypingEntries(
  entries: ClientTypingEntry[],
  nowMs = Date.now(),
): ClientTypingEntry[] {
  return entries.filter((entry) => entry.expiresAt > nowMs);
}

export function registerTypingEntry(
  entries: ClientTypingEntry[],
  typing: TypingIndicatorView,
  viewerPubkey: string,
  nowMs = Date.now(),
): ClientTypingEntry[] {
  const current = pruneTypingEntries(entries, nowMs);
  const expiresAt = typing.createdAt * 1_000 + TYPING_INDICATOR_TTL_MS;
  if (
    typing.pubkey === viewerPubkey.toLowerCase() ||
    expiresAt <= nowMs ||
    typing.createdAt * 1_000 > nowMs + TYPING_INDICATOR_TTL_MS
  ) {
    return current;
  }
  const next = { ...typing, expiresAt };
  return [...current.filter((entry) => key(entry) !== key(next)), next];
}

export function clearCompletedTyping(
  entries: ClientTypingEntry[],
  snapshot: ChannelSnapshot,
  nowMs = Date.now(),
): ClientTypingEntry[] {
  return pruneTypingEntries(entries, nowMs).filter((entry) => {
    const messages = entry.threadHeadId
      ? snapshot.thread?.rootId === entry.threadHeadId
        ? [snapshot.thread.root, ...snapshot.thread.replies]
        : []
      : snapshot.timeline;
    return !messages.some(
      (message) =>
        message?.author.pubkey === entry.pubkey &&
        message.createdAt >= entry.createdAt,
    );
  });
}
