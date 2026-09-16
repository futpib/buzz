import "server-only";

import { nip19 } from "nostr-tools";

type ServerConfig = {
  relayHttpUrl: string;
  relayWsUrl: string;
  secretKey: Uint8Array;
  authTag: string[] | null;
  authTagJson: string | null;
  defaultChannelId: string | null;
};

let cached: ServerConfig | null = null;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseSecretKey(value: string): Uint8Array {
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return Uint8Array.from(Buffer.from(value, "hex"));
  }
  if (value.startsWith("nsec1")) {
    const decoded = nip19.decode(value);
    if (decoded.type === "nsec") {
      return decoded.data;
    }
  }
  throw new Error("BUZZ_PRIVATE_KEY must be a 64-character hex key or nsec");
}

function normalizeHttpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("BUZZ_RELAY_URL must use http(s) or ws(s)");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function toWsUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/, "");
}

function parseAuthTag(): Pick<ServerConfig, "authTag" | "authTagJson"> {
  const raw = process.env.BUZZ_AUTH_TAG?.trim();
  if (!raw) return { authTag: null, authTagJson: null };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("BUZZ_AUTH_TAG must be valid JSON");
  }
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some((part) => typeof part !== "string") ||
    value[0] !== "auth"
  ) {
    throw new Error("BUZZ_AUTH_TAG must be a four-string auth tag");
  }
  return { authTag: value as string[], authTagJson: raw };
}

export function getServerConfig(): ServerConfig {
  if (cached) return cached;
  const relayHttpUrl = normalizeHttpUrl(requireEnv("BUZZ_RELAY_URL"));
  cached = {
    relayHttpUrl,
    relayWsUrl: toWsUrl(relayHttpUrl),
    secretKey: parseSecretKey(requireEnv("BUZZ_PRIVATE_KEY")),
    ...parseAuthTag(),
    defaultChannelId: process.env.BUZZ_WEB_DEFAULT_CHANNEL?.trim() || null,
  };
  return cached;
}
