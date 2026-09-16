"use client";

import { finalizeEvent, nip19 } from "nostr-tools";

import type { NostrEvent } from "@/server/types";
import { BROWSER_CREDENTIAL_KEY } from "@/shared/auth";

export type BrowserCredential = {
  nsec: string;
  authTag: string[] | null;
};

function secretKey(nsec: string): Uint8Array {
  const decoded = nip19.decode(nsec.trim());
  if (decoded.type !== "nsec") throw new Error("Enter a valid nsec key");
  return decoded.data;
}

export function parseAuthTag(raw: string): string[] | null {
  if (!raw.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Agent credential must be valid JSON");
  }
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some((part) => typeof part !== "string") ||
    value[0] !== "auth"
  ) {
    throw new Error("Agent credential must be a four-string auth tag");
  }
  return value as string[];
}

export function makeAuthEvent(
  credential: BrowserCredential,
  challenge: string,
  relayUrl: string,
  createdAt = Math.floor(Date.now() / 1000),
): NostrEvent {
  const tags = [
    ["relay", relayUrl],
    ["challenge", challenge],
  ];
  if (credential.authTag) tags.push([...credential.authTag]);
  return finalizeEvent(
    { kind: 22242, created_at: createdAt, tags, content: "" },
    secretKey(credential.nsec),
  ) as NostrEvent;
}

export function makeMessageEvent(
  credential: BrowserCredential,
  input: {
    channelId: string;
    content: string;
    rootId?: string | null;
    forum?: boolean;
  },
): NostrEvent {
  const tags = [["h", input.channelId]];
  if (input.rootId) tags.push(["e", input.rootId, "", "reply"]);
  if (credential.authTag) tags.push([...credential.authTag]);
  const kind = input.rootId
    ? input.forum
      ? 45003
      : 9
    : input.forum
      ? 45001
      : 9;
  return finalizeEvent(
    {
      kind,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: input.content,
    },
    secretKey(credential.nsec),
  ) as NostrEvent;
}

export function makeMediaGetAuthEvent(
  credential: BrowserCredential,
  server: string,
  createdAt = Math.floor(Date.now() / 1000),
): NostrEvent {
  const authority = server.trim().toLowerCase();
  if (!authority || /[/@]/.test(authority)) {
    throw new Error("Media server is invalid");
  }
  return finalizeEvent(
    {
      kind: 24_242,
      created_at: createdAt,
      tags: [
        ["t", "get"],
        ["expiration", String(createdAt + 600)],
        ["server", authority],
      ],
      content: "Get buzz-media",
    },
    secretKey(credential.nsec),
  ) as NostrEvent;
}

export function encodeNostrAuthorization(event: NostrEvent): string {
  const bytes = new TextEncoder().encode(JSON.stringify(event));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Nostr ${btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")}`;
}

export function storeCredential(credential: BrowserCredential): void {
  sessionStorage.setItem(BROWSER_CREDENTIAL_KEY, JSON.stringify(credential));
}

export function loadCredential(): BrowserCredential | null {
  const raw = sessionStorage.getItem(BROWSER_CREDENTIAL_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<BrowserCredential>;
    if (typeof parsed.nsec !== "string") return null;
    if (
      parsed.authTag !== null &&
      parsed.authTag !== undefined &&
      (!Array.isArray(parsed.authTag) ||
        parsed.authTag.some((part) => typeof part !== "string"))
    ) {
      return null;
    }
    return { nsec: parsed.nsec, authTag: parsed.authTag ?? null };
  } catch {
    return null;
  }
}

export function forgetCredential(): void {
  sessionStorage.removeItem(BROWSER_CREDENTIAL_KEY);
}
