"use client";

import {
  loadSigningCredential,
  makeAuthEvent,
  signingIdentitySignal,
  type BrowserCredential,
} from "@/client/identity";

export async function responseError(
  response: Response,
  fallback: string,
): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  return typeof body?.error === "string"
    ? body.error
    : `${fallback} (HTTP ${response.status})`;
}

/** Exchange only a public signed challenge for the HttpOnly browser session. */
export async function createBrowserSession(
  credential: BrowserCredential,
  identitySignal?: AbortSignal,
): Promise<void> {
  const signal = () =>
    identitySignal
      ? AbortSignal.any([identitySignal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000);
  identitySignal?.throwIfAborted();
  const startResponse = await fetch("/api/auth/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: signal(),
  });
  if (!startResponse.ok)
    throw new Error(
      await responseError(startResponse, "Login could not start"),
    );
  const start = (await startResponse.json()) as {
    attemptId: string;
    challenge: string;
    relayUrl: string;
  };
  identitySignal?.throwIfAborted();
  const event = makeAuthEvent(credential, start.challenge, start.relayUrl);
  const response = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attemptId: start.attemptId, event }),
    signal: signal(),
  });
  if (!response.ok)
    throw new Error(await responseError(response, "Login failed"));
}

const recoveries = new Map<string, Promise<void>>();

/** Coalesce recovery for concurrent preference writes, preserving the local signer and outbox. */
export function restoreBrowserSession(pubkey: string): Promise<void> {
  const current = recoveries.get(pubkey);
  if (current) return current;
  const identitySignal = signingIdentitySignal();
  const request = (async () => {
    const credential = await loadSigningCredential(pubkey);
    if (!credential)
      throw new Error("Sign in again to sync your saved preferences");
    await createBrowserSession(credential, identitySignal);
  })().finally(() => recoveries.delete(pubkey));
  recoveries.set(pubkey, request);
  return request;
}
