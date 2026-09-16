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
