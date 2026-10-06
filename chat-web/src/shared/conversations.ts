import type { ChannelView, ProfileView } from "@/server/types";

export type ConversationAction =
  | { action: "dm"; pubkeys: string[] }
  | {
      action: "create";
      channelId: string;
      name: string;
      about: string;
      visibility: "open" | "private";
      type: "stream" | "forum";
    }
  | { action: "join" | "leave"; channelId: string }
  | {
      action: "add" | "remove";
      channelId: string;
      pubkey: string;
      role?: string;
    }
  | { action: "update"; channelId: string; changes: Record<string, string> };

export type ConversationMember = ProfileView & { role: string };
export type ConversationDetails = {
  channel: ChannelView;
  about: string;
  topic: string;
  purpose: string;
  ttl: string;
  members: ConversationMember[];
  canManage: boolean;
  canLeave: boolean;
};
export type ConversationDirectory = {
  channels: (ChannelView & { joined: boolean })[];
  people: ProfileView[];
  generatedAt: number;
  cacheState: string;
};
export const CHANNEL_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const PERSON_KEY = /^[0-9a-f]{64}$/;

/** Match the SDK wire format; management uses commands, never discovery snapshots. */
export function conversationCommand(input: ConversationAction): {
  kind: number;
  tags: string[][];
} {
  if (input.action === "dm") {
    if (
      !input.pubkeys.length ||
      input.pubkeys.length > 8 ||
      input.pubkeys.some((key) => !PERSON_KEY.test(key))
    )
      throw new Error("Choose between one and eight people");
    return {
      kind: 41010,
      tags: [...new Set(input.pubkeys)].map((key) => ["p", key]),
    };
  }
  if (!CHANNEL_ID.test(input.channelId)) throw new Error("Invalid channel");
  const tags = [["h", input.channelId]];
  if (input.action === "create") {
    const name = input.name.trim().replace(/^#+/, "").trim();
    if (!name || name.length > 100)
      throw new Error("Channel name must be 1–100 characters");
    if (
      !["open", "private"].includes(input.visibility) ||
      !["stream", "forum"].includes(input.type)
    )
      throw new Error("Invalid channel options");
    if (typeof input.about !== "string" || input.about.length > 8000)
      throw new Error("Description is too long");
    return {
      kind: 9007,
      tags: [
        ...tags,
        ["name", name],
        ["about", input.about],
        ["visibility", input.visibility],
        ["channel_type", input.type],
      ],
    };
  }
  if (input.action === "join" || input.action === "leave")
    return { kind: input.action === "join" ? 9021 : 9022, tags };
  if (input.action === "add" || input.action === "remove") {
    if (!PERSON_KEY.test(input.pubkey)) throw new Error("Invalid member");
    tags.push(["p", input.pubkey]);
    if (input.role) {
      if (
        input.action !== "add" ||
        !["owner", "admin", "member", "guest", "bot"].includes(input.role)
      )
        throw new Error("Invalid member role");
      tags.push(["role", input.role]);
    }
    return { kind: input.action === "add" ? 9000 : 9001, tags };
  }
  if (input.action !== "update") throw new Error("Unknown conversation action");
  for (const [key, value] of Object.entries(input.changes)) {
    if (
      ![
        "name",
        "about",
        "topic",
        "purpose",
        "visibility",
        "ttl",
        "archived",
      ].includes(key) ||
      typeof value !== "string" ||
      value.length > 8000
    )
      throw new Error("Invalid channel setting");
    if (
      key === "name" &&
      (!value.trim().replace(/^#+/, "").trim() || value.length > 100)
    )
      throw new Error("Channel name is required");
    if (key === "visibility" && !["open", "private"].includes(value))
      throw new Error("Invalid visibility");
    if (key === "archived" && !["true", "false"].includes(value))
      throw new Error("Invalid archive state");
    if (
      key === "ttl" &&
      value !== "" &&
      (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 2147483647)
    )
      throw new Error("Expiry must be a positive number of seconds");
    tags.push([
      key,
      key === "name" ? value.trim().replace(/^#+/, "").trim() : value,
    ]);
  }
  if (tags.length === 1) throw new Error("No settings changed");
  return { kind: 9002, tags };
}
