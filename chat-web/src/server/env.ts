import "server-only";

type ServerConfig = {
  relayHttpUrl: string;
  relayWsUrl: string;
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

function normalizeWsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Pairing relay URL must use ws(s)");
  }
  if (!url.hostname || url.username || url.password || url.hash) {
    throw new Error("Pairing relay URL is invalid");
  }
  return url.toString();
}

function legacyPairingUrl(relayWsUrl: string): string {
  const url = new URL(relayWsUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/pair`;
  return url.toString();
}

export function getServerConfig(): ServerConfig {
  if (cached) return cached;
  const relayHttpUrl = normalizeHttpUrl(requireEnv("BUZZ_RELAY_URL"));
  cached = {
    relayHttpUrl,
    relayWsUrl: toWsUrl(relayHttpUrl),
    defaultChannelId: process.env.BUZZ_WEB_DEFAULT_CHANNEL?.trim() || null,
  };
  return cached;
}

export async function getPairingRelayUrl(): Promise<string> {
  const override = process.env.BUZZ_PAIRING_RELAY_URL?.trim();
  if (override) return normalizeWsUrl(override);

  const config = getServerConfig();
  try {
    const response = await fetch(config.relayHttpUrl, {
      headers: { Accept: "application/nostr+json" },
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
    if (!response.ok) return config.relayWsUrl;
    const document = (await response.json()) as {
      pairing_relay_url?: unknown;
      supported_nips?: unknown;
    };
    if (typeof document.pairing_relay_url === "string") {
      try {
        return normalizeWsUrl(document.pairing_relay_url);
      } catch {
        // Fall through to the NIP-43 compatibility path.
      }
    }
    if (
      Array.isArray(document.supported_nips) &&
      document.supported_nips.includes(43)
    ) {
      return legacyPairingUrl(config.relayWsUrl);
    }
  } catch {
    // The main relay remains a valid NIP-01 pairing transport.
  }
  return config.relayWsUrl;
}
