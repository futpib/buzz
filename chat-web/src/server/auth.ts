import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { validateAuthEvent } from "@/server/auth-proof";
import { RelayConnection } from "@/server/relay";
import type { NostrEvent } from "@/server/types";
import { SESSION_COOKIE } from "@/shared/auth";

const MAX_PENDING_LOGINS = 32;
const MAX_SESSIONS = 128;
const LOGIN_TTL_MS = 4_500;
const SESSION_TTL_MS = 8 * 60 * 60 * 1_000;

export type AuthSession = {
  pubkey: string;
  authTag: string[] | null;
  relay: RelayConnection;
  createdAt: number;
  lastUsedAt: number;
};

type PendingLogin = {
  relay: RelayConnection;
  expiresAt: number;
};

type AuthState = {
  opening: number;
  pending: Map<string, PendingLogin>;
  sessions: Map<string, AuthSession>;
};

const globalAuth = globalThis as typeof globalThis & {
  __buzzWebAuth?: AuthState;
};

if (!globalAuth.__buzzWebAuth) {
  globalAuth.__buzzWebAuth = {
    opening: 0,
    pending: new Map(),
    sessions: new Map(),
  };
}
const state = globalAuth.__buzzWebAuth;
if (typeof state.opening !== "number") state.opening = 0;

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function oldestEntry<T>(
  map: Map<string, T>,
  timestamp: (value: T) => number,
): [string, T] | null {
  let oldest: [string, T] | null = null;
  for (const entry of map) {
    if (!oldest || timestamp(entry[1]) < timestamp(oldest[1])) oldest = entry;
  }
  return oldest;
}

function prune(now = Date.now()): void {
  for (const [id, pending] of state.pending) {
    if (pending.expiresAt <= now || !pending.relay.isOpen()) {
      pending.relay.close();
      state.pending.delete(id);
    }
  }
  for (const [hash, session] of state.sessions) {
    if (session.lastUsedAt + SESSION_TTL_MS <= now || !session.relay.isOpen()) {
      session.relay.close();
      state.sessions.delete(hash);
    }
  }
}

export async function beginLogin(): Promise<{
  attemptId: string;
  challenge: string;
  relayUrl: string;
}> {
  prune();
  if (state.pending.size + state.opening >= MAX_PENDING_LOGINS) {
    throw new Error("Too many login attempts; try again in a moment");
  }
  state.opening += 1;
  let relay: RelayConnection;
  try {
    relay = await RelayConnection.open();
  } finally {
    state.opening -= 1;
  }
  const attemptId = randomUUID();
  state.pending.set(attemptId, {
    relay,
    expiresAt: Date.now() + LOGIN_TTL_MS,
  });
  return { attemptId, challenge: relay.challenge, relayUrl: relay.relayUrl };
}

export async function completeLogin(
  attemptId: string,
  event: NostrEvent,
): Promise<{ token: string; pubkey: string }> {
  prune();
  const pending = state.pending.get(attemptId);
  state.pending.delete(attemptId);
  if (!pending || pending.expiresAt <= Date.now()) {
    pending?.relay.close();
    throw new Error("Login attempt expired; try again");
  }
  try {
    validateAuthEvent(event, pending.relay.challenge, pending.relay.relayUrl);
    await pending.relay.authenticate(event);
  } catch (error) {
    pending.relay.close();
    throw error;
  }

  prune();
  if (state.sessions.size >= MAX_SESSIONS) {
    const evicted = oldestEntry(state.sessions, (value) => value.lastUsedAt);
    if (evicted) {
      evicted[1].relay.close();
      state.sessions.delete(evicted[0]);
    }
  }
  const token = randomBytes(32).toString("base64url");
  const hash = tokenHash(token);
  const session: AuthSession = {
    pubkey: event.pubkey,
    authTag:
      event.tags.filter((tag) => tag[0] === "auth").length === 1
        ? [...(event.tags.find((tag) => tag[0] === "auth") ?? [])]
        : null,
    relay: pending.relay,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };
  pending.relay.setCloseHandler(() => state.sessions.delete(hash));
  state.sessions.set(hash, session);
  return { token, pubkey: event.pubkey };
}

export function getSessionByToken(
  token: string | undefined,
): AuthSession | null {
  if (!token) return null;
  prune();
  const session = state.sessions.get(tokenHash(token));
  if (!session?.relay.isOpen()) return null;
  session.lastUsedAt = Date.now();
  return session;
}

export async function getCurrentSession(): Promise<AuthSession | null> {
  const store = await cookies();
  return getSessionByToken(store.get(SESSION_COOKIE)?.value);
}

export async function requireSession(): Promise<AuthSession> {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  return session;
}

function cookieValue(request: Request): string | undefined {
  const cookie = request.headers.get("cookie") ?? "";
  const value = cookie
    .split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === SESSION_COOKIE)?.[1];
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export function getRequestSession(request: Request): AuthSession | null {
  return getSessionByToken(cookieValue(request));
}

export function destroyRequestSession(request: Request): void {
  const token = cookieValue(request);
  if (!token) return;
  const hash = tokenHash(token);
  state.sessions.get(hash)?.relay.close();
  state.sessions.delete(hash);
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) throw new Error("Request origin is required");
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host || new URL(origin).host !== host) {
    throw new Error("Cross-origin request rejected");
  }
}
