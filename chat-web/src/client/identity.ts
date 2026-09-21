"use client";

import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";

import type { NostrEvent } from "@/server/types";
import { BROWSER_CREDENTIAL_KEY } from "@/shared/auth";
import { TYPING_INDICATOR_KIND } from "@/shared/typing";

export type BrowserCredential = {
  nsec: string;
  authTag: string[] | null;
};

const IDENTITY_DATABASE = "buzz-web-identity";
const IDENTITY_STORE = "credentials";
const IDENTITY_RECORD = "current";
const PERSISTENT_CREDENTIAL_KEY = "buzz.identity.persistent.v1";
const IDENTITY_DATABASE_TIMEOUT_MS = 1_500;
let persistentCredentialRequest: Promise<BrowserCredential | null> | null =
  null;
let identityGeneration = 0;
let memoryCredential: BrowserCredential | null = null;

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
    parentId?: string | null;
    forum?: boolean;
    imetaTags?: string[][];
  },
): NostrEvent {
  const tags = [["h", input.channelId]];
  if (input.rootId) {
    if (input.parentId && input.parentId !== input.rootId) {
      tags.push(["e", input.rootId, "", "root"]);
      tags.push(["e", input.parentId, "", "reply"]);
    } else {
      tags.push(["e", input.rootId, "", "reply"]);
    }
  }
  for (const tag of input.imetaTags ?? []) {
    if (tag[0] !== "imeta") throw new Error("Attachment metadata is invalid");
    tags.push([...tag]);
  }
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

function actionTags(
  credential: BrowserCredential,
  tags: string[][],
): string[][] {
  const result = tags.map((tag) => [...tag]);
  if (credential.authTag) result.push([...credential.authTag]);
  return result;
}

/** Kind 7 — a NIP-25 reaction to one delivered message. */
export function makeReactionEvent(
  credential: BrowserCredential,
  targetId: string,
  emoji: string,
  createdAt = Math.floor(Date.now() / 1_000),
): NostrEvent {
  const value = emoji.trim();
  if (!/^[0-9a-f]{64}$/i.test(targetId)) {
    throw new Error("Reaction target is invalid");
  }
  if (!value || [...value].length > 64) {
    throw new Error("Reaction emoji is invalid");
  }
  return finalizeEvent(
    {
      kind: 7,
      created_at: createdAt,
      tags: actionTags(credential, [["e", targetId]]),
      content: value,
    },
    secretKey(credential.nsec),
  ) as NostrEvent;
}

/** Kind 40003 — replace a message's visible text. */
export function makeMessageEditEvent(
  credential: BrowserCredential,
  input: { channelId: string; targetId: string; content: string },
  createdAt = Math.floor(Date.now() / 1_000),
): NostrEvent {
  const content = input.content.trim();
  if (!content) throw new Error("Edited message cannot be empty");
  return finalizeEvent(
    {
      kind: 40_003,
      created_at: createdAt,
      tags: actionTags(credential, [
        ["h", input.channelId],
        ["e", input.targetId],
      ]),
      content,
    },
    secretKey(credential.nsec),
  ) as NostrEvent;
}

/** Kind 5 — remove a message, or remove one of the viewer's reactions. */
export function makeDeletionEvent(
  credential: BrowserCredential,
  input: { targetId: string; channelId?: string | null },
  createdAt = Math.floor(Date.now() / 1_000),
): NostrEvent {
  const tags = input.channelId
    ? [
        ["h", input.channelId],
        ["e", input.targetId],
      ]
    : [["e", input.targetId]];
  return finalizeEvent(
    {
      kind: 5,
      created_at: createdAt,
      tags: actionTags(credential, tags),
      content: "",
    },
    secretKey(credential.nsec),
  ) as NostrEvent;
}

export function makeTypingEvent(
  credential: BrowserCredential,
  input: {
    channelId: string;
    threadHeadId?: string | null;
    rootId?: string | null;
  },
): NostrEvent {
  const tags = [["h", input.channelId]];
  if (input.threadHeadId) {
    if (input.rootId && input.rootId !== input.threadHeadId) {
      tags.push(["e", input.rootId, "", "root"]);
    }
    tags.push(["e", input.threadHeadId, "", "reply"]);
  }
  if (credential.authTag) tags.push([...credential.authTag]);
  return finalizeEvent(
    {
      kind: TYPING_INDICATOR_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: "",
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

export function makeMediaUploadAuthEvent(
  credential: BrowserCredential,
  server: string,
  hash: string,
  mime: string,
  createdAt = Math.floor(Date.now() / 1000),
): NostrEvent {
  const authority = server.trim().toLowerCase();
  if (!authority || /[/@]/.test(authority)) {
    throw new Error("Media server is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error("Attachment hash is invalid");
  }
  const lifetime = mime.toLowerCase() === "video/mp4" ? 3_600 : 600;
  return finalizeEvent(
    {
      kind: 24_242,
      created_at: createdAt,
      tags: [
        ["t", "upload"],
        ["x", hash],
        ["expiration", String(createdAt + lifetime)],
        ["server", authority],
      ],
      content: "Upload file",
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

function parseStoredCredential(raw: unknown): BrowserCredential | null {
  try {
    const parsed =
      typeof raw === "string"
        ? (JSON.parse(raw) as Partial<BrowserCredential>)
        : (raw as Partial<BrowserCredential>);
    if (!parsed || typeof parsed.nsec !== "string") return null;
    if (
      parsed.authTag !== null &&
      parsed.authTag !== undefined &&
      (!Array.isArray(parsed.authTag) ||
        parsed.authTag.some((part) => typeof part !== "string"))
    ) {
      return null;
    }
    const nsec = parsed.nsec.trim();
    secretKey(nsec);
    return { nsec, authTag: parsed.authTag ?? null };
  } catch {
    return null;
  }
}

function storageValue(
  storage: Storage | undefined,
  key: string,
): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function setStorageValue(
  storage: Storage | undefined,
  key: string,
  value: string,
): boolean {
  try {
    storage?.setItem(key, value);
    return storage !== undefined;
  } catch {
    return false;
  }
}

function removeStorageValue(storage: Storage | undefined, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // A denied storage backend must not block the remaining cleanup paths.
  }
}

function browserSessionStorage(): Storage | undefined {
  return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
}

function browserLocalStorage(): Storage | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

function activateCredential(credential: BrowserCredential): void {
  memoryCredential = credential;
  setStorageValue(
    browserSessionStorage(),
    BROWSER_CREDENTIAL_KEY,
    JSON.stringify(credential),
  );
}

export function credentialPubkey(credential: BrowserCredential): string {
  return getPublicKey(secretKey(credential.nsec));
}

function openIdentityDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("Identity database is unavailable"));
      return;
    }
    const request = indexedDB.open(IDENTITY_DATABASE, 1);
    let settled = false;
    const finish = (database?: IDBDatabase, error?: Error) => {
      if (settled) {
        database?.close();
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else if (database) resolve(database);
    };
    const timeout = setTimeout(
      () => finish(undefined, new Error("Identity database timed out")),
      IDENTITY_DATABASE_TIMEOUT_MS,
    );
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(IDENTITY_STORE)) {
        request.result.createObjectStore(IDENTITY_STORE);
      }
    };
    request.onsuccess = () => finish(request.result);
    request.onerror = () =>
      finish(undefined, request.error ?? new Error("Identity storage failed"));
    request.onblocked = () =>
      finish(undefined, new Error("Identity database is blocked"));
  });
}

async function persistentIdentity(
  mode: "get" | "put" | "delete",
  credential?: BrowserCredential,
): Promise<unknown> {
  const database = await openIdentityDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(
        IDENTITY_STORE,
        mode === "get" ? "readonly" : "readwrite",
      );
      const store = transaction.objectStore(IDENTITY_STORE);
      const request =
        mode === "get"
          ? store.get(IDENTITY_RECORD)
          : mode === "put"
            ? store.put(credential, IDENTITY_RECORD)
            : store.delete(IDENTITY_RECORD);
      let result: unknown;
      let settled = false;
      const finish = (value?: unknown, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(value);
      };
      const timeout = setTimeout(() => {
        try {
          transaction.abort();
        } catch {
          // A transaction that already completed needs no further cleanup.
        }
        finish(undefined, new Error("Identity storage timed out"));
      }, IDENTITY_DATABASE_TIMEOUT_MS);
      request.onsuccess = () => {
        result = request.result;
      };
      transaction.oncomplete = () => finish(result);
      transaction.onerror = () =>
        finish(
          undefined,
          transaction.error ?? new Error("Identity storage failed"),
        );
      transaction.onabort = () =>
        finish(
          undefined,
          transaction.error ?? new Error("Identity storage was aborted"),
        );
    });
  } finally {
    database.close();
  }
}

export async function storeCredential(
  credential: BrowserCredential,
): Promise<void> {
  const parsed = parseStoredCredential(credential);
  if (!parsed) throw new Error("Browser credential is invalid");
  identityGeneration += 1;
  activateCredential(parsed);
  setStorageValue(
    browserLocalStorage(),
    PERSISTENT_CREDENTIAL_KEY,
    JSON.stringify(parsed),
  );
  try {
    await persistentIdentity("put", parsed);
  } catch {
    // IndexedDB is unreliable in some mobile/private browser contexts. The
    // browser-only local fallback and active in-memory copy keep signing usable.
  }
}

export function loadCredential(): BrowserCredential | null {
  if (memoryCredential) return memoryCredential;
  const raw = storageValue(browserSessionStorage(), BROWSER_CREDENTIAL_KEY);
  if (!raw) return null;
  const credential = parseStoredCredential(raw);
  if (credential) memoryCredential = credential;
  else removeStorageValue(browserSessionStorage(), BROWSER_CREDENTIAL_KEY);
  return credential;
}

export async function loadPersistentCredential(): Promise<BrowserCredential | null> {
  const generation = identityGeneration;
  const local = parseStoredCredential(
    storageValue(browserLocalStorage(), PERSISTENT_CREDENTIAL_KEY),
  );
  if (local) {
    if (generation === identityGeneration) activateCredential(local);
    void persistentIdentity("put", local)
      .then(() => {
        if (generation !== identityGeneration) {
          return persistentIdentity("delete");
        }
        return undefined;
      })
      .catch(() => undefined);
    return generation === identityGeneration ? local : null;
  }
  removeStorageValue(browserLocalStorage(), PERSISTENT_CREDENTIAL_KEY);
  try {
    const credential = parseStoredCredential(await persistentIdentity("get"));
    if (credential && generation === identityGeneration) {
      activateCredential(credential);
      setStorageValue(
        browserLocalStorage(),
        PERSISTENT_CREDENTIAL_KEY,
        JSON.stringify(credential),
      );
    }
    return generation === identityGeneration ? credential : null;
  } catch {
    return null;
  }
}

export async function loadSigningCredential(
  expectedPubkey?: string,
): Promise<BrowserCredential | null> {
  const active = loadCredential();
  if (
    active &&
    (!expectedPubkey || credentialPubkey(active) === expectedPubkey)
  ) {
    return active;
  }
  if (!persistentCredentialRequest) {
    persistentCredentialRequest = loadPersistentCredential().finally(() => {
      persistentCredentialRequest = null;
    });
  }
  const persistent = await persistentCredentialRequest;
  if (
    persistent &&
    (!expectedPubkey || credentialPubkey(persistent) === expectedPubkey)
  ) {
    return persistent;
  }
  if (expectedPubkey) await forgetCredential();
  return null;
}

export async function forgetCredential(): Promise<void> {
  identityGeneration += 1;
  memoryCredential = null;
  removeStorageValue(browserSessionStorage(), BROWSER_CREDENTIAL_KEY);
  removeStorageValue(browserLocalStorage(), PERSISTENT_CREDENTIAL_KEY);
  try {
    await persistentIdentity("delete");
  } catch {
    // A failed database deletion must not retain the active tab credential.
  }
}
