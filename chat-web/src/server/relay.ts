import "server-only";

import { getServerConfig } from "@/server/env";
import { makeNip98AuthHeader } from "@/server/nostr";
import type { NostrEvent } from "@/server/types";

export type RelayFilter = Record<string, unknown>;

const REQUEST_TIMEOUT_MS = 15_000;

async function relayPost<T>(path: string, payload: unknown): Promise<T> {
  const config = getServerConfig();
  const url = `${config.relayHttpUrl}${path}`;
  const body = JSON.stringify(payload);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: makeNip98AuthHeader(url, "POST", body),
      "Content-Type": "application/json",
      ...(config.authTagJson ? { "x-auth-tag": config.authTagJson } : {}),
    },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string };
      detail = parsed.error ?? parsed.message ?? detail;
    } catch {
      if (text.trim()) detail = text.trim().slice(0, 240);
    }
    throw new Error(`Buzz relay request failed: ${detail}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Buzz relay returned invalid JSON");
  }
}

export async function queryRelay(
  filters: RelayFilter[],
): Promise<NostrEvent[]> {
  return relayPost<NostrEvent[]>("/query", filters);
}

export async function submitRelayEvent(
  event: NostrEvent,
): Promise<{ accepted: boolean; event_id?: string; message?: string }> {
  const result = await relayPost<{
    accepted: boolean;
    event_id?: string;
    message?: string;
  }>("/events", event);
  if (!result.accepted) {
    throw new Error(result.message || "Buzz relay rejected the message");
  }
  return result;
}
