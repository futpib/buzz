"use client";

const UNREAD_PREFIX = "buzz.message-unread.v1";
const FOLLOW_PREFIX = "buzz.thread-follows.v1";
const MAX_ENTRIES = 500;

type StoredEntry = { id: string; changedAt: number };

function key(prefix: string, pubkey: string): string {
  return `${prefix}:${pubkey.toLowerCase()}`;
}

function read(storage: Storage, storageKey: string): StoredEntry[] {
  try {
    const parsed = JSON.parse(storage.getItem(storageKey) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is StoredEntry =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as StoredEntry).id === "string" &&
          typeof (entry as StoredEntry).changedAt === "number",
      )
      .slice(-MAX_ENTRIES);
  } catch {
    return [];
  }
}

function contains(storage: Storage, storageKey: string, id: string): boolean {
  return read(storage, storageKey).some((entry) => entry.id === id);
}

function set(
  storage: Storage,
  storageKey: string,
  id: string,
  enabled: boolean,
): boolean {
  try {
    const current = read(storage, storageKey).filter(
      (entry) => entry.id !== id,
    );
    const next = enabled
      ? [...current, { id, changedAt: Date.now() }].slice(-MAX_ENTRIES)
      : current;
    storage.setItem(storageKey, JSON.stringify(next));
    return enabled;
  } catch {
    return enabled;
  }
}

export function isMessageForcedUnread(
  pubkey: string,
  messageId: string,
): boolean {
  try {
    return contains(localStorage, key(UNREAD_PREFIX, pubkey), messageId);
  } catch {
    return false;
  }
}

export function setMessageForcedUnread(
  pubkey: string,
  messageId: string,
  unread: boolean,
): boolean {
  try {
    return set(localStorage, key(UNREAD_PREFIX, pubkey), messageId, unread);
  } catch {
    return unread;
  }
}

export function isThreadFollowed(pubkey: string, rootId: string): boolean {
  try {
    return contains(localStorage, key(FOLLOW_PREFIX, pubkey), rootId);
  } catch {
    return false;
  }
}

export function setThreadFollowed(
  pubkey: string,
  rootId: string,
  followed: boolean,
): boolean {
  try {
    return set(localStorage, key(FOLLOW_PREFIX, pubkey), rootId, followed);
  } catch {
    return followed;
  }
}
