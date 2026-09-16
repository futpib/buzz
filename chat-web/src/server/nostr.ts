import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools";

import { getServerConfig } from "@/server/env";
import type { NostrEvent } from "@/server/types";

export function serverPubkey(): string {
  return getPublicKey(getServerConfig().secretKey);
}

export function signEvent(template: EventTemplate): NostrEvent {
  const config = getServerConfig();
  const tags = config.authTag
    ? [...template.tags, [...config.authTag]]
    : template.tags;
  return finalizeEvent({ ...template, tags }, config.secretKey) as NostrEvent;
}

export function makeNip98AuthHeader(
  url: string,
  method: "POST" | "GET",
  body: string,
): string {
  const payload = createHash("sha256").update(body).digest("hex");
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["u", url],
        ["method", method],
        ["payload", payload],
        ["nonce", randomUUID()],
      ],
      content: "",
    },
    getServerConfig().secretKey,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

export function makeNip42AuthEvent(challenge: string): NostrEvent {
  const config = getServerConfig();
  const tags = [
    ["relay", config.relayWsUrl],
    ["challenge", challenge],
  ];
  if (config.authTag) tags.push([...config.authTag]);
  return finalizeEvent(
    {
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: "",
    },
    config.secretKey,
  ) as NostrEvent;
}
