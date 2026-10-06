import { invalidateMemberViews } from "@/server/members";
import { assertSameOrigin, getRequestSession } from "@/server/auth";
import {
  loadConversationDirectory,
  loadConversationDetails,
  invalidateConversationDirectory,
  readChannelState,
} from "@/server/conversations";
import {
  validateConversationEvent,
  dmChannelFromAck,
} from "@/server/conversation-validation";
import { invalidateConversationViews } from "@/server/data";
import { markNavigationViewsStale } from "@/server/navigation";
import { markInboxViewsStale } from "@/server/inbox";
import { markActivityViewsStale } from "@/server/activity";
import { markSentViewsStale } from "@/server/sent";
import { markSearchViewsStale } from "@/server/search";
import { CHANNEL_ID, type ConversationAction } from "@/shared/conversations";
import type { NostrEvent } from "@/server/types";
export const dynamic = "force-dynamic";
const fail = (e: unknown) =>
  Response.json(
    { error: e instanceof Error ? e.message : "Conversation request failed" },
    { status: 400 },
  );
export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session)
    return Response.json({ error: "Login required" }, { status: 401 });
  try {
    const params = new URL(request.url).searchParams;
    const channel = params.get("channel");
    return Response.json(
      channel
        ? await loadConversationDetails(session, channel)
        : await loadConversationDirectory(session, params.get("fresh") === "1"),
    );
  } catch (e) {
    return fail(e);
  }
}
export async function POST(request: Request) {
  let accepted = false;
  let channelId: string | null = null;
  try {
    assertSameOrigin(request);
    const session = getRequestSession(request);
    if (!session)
      return Response.json({ error: "Login required" }, { status: 401 });
    const raw = await request.text();
    if (raw.length > 32 * 1024)
      throw new Error("Conversation request is too large");
    const { input, event } = JSON.parse(raw) as {
      input: ConversationAction;
      event: NostrEvent;
    };
    validateConversationEvent(session.pubkey, input, event);
    // The relay is the final authority, including owner-of-agent exceptions.
    let alreadyCreated = false;
    if (input.action === "create") {
      const current = await readChannelState(session, input.channelId);
      alreadyCreated = Boolean(
        current.metadata &&
          current.roster?.tags.some(
            (t) => t[0] === "p" && t[1] === session.pubkey && t[3] === "owner",
          ) &&
          current.metadata.tags.some(
            (t) =>
              t[0] === "name" &&
              t[1] === event.tags.find((t) => t[0] === "name")?.[1],
          ),
      );
    }
    const ack = alreadyCreated ? "" : await session.relay.publishCommand(event);
    accepted = true;
    channelId = input.action === "dm" ? dmChannelFromAck(ack) : input.channelId;
    invalidateConversationDirectory(session);
    invalidateConversationViews(session);
    if (channelId) invalidateMemberViews(session, channelId);
    if (input.action === "dm" && !channelId) {
      // A retried command may receive a duplicate OK without its original response.
      const directory = await loadConversationDirectory(session, true);
      const participants = new Set([session.pubkey, ...input.pubkeys]);
      for (const channel of directory.channels.filter(
        (c) => c.type === "dm" && c.joined,
      )) {
        const { roster } = await readChannelState(session, channel.id);
        const keys =
          roster?.tags.filter((t) => t[0] === "p").map((t) => t[1]) ?? [];
        if (
          keys.length === participants.size &&
          keys.every((key) => participants.has(key))
        ) {
          channelId = channel.id;
          break;
        }
      }
    }
    invalidateConversationDirectory(session);
    invalidateConversationViews(session);
    markNavigationViewsStale(session);
    markInboxViewsStale(session);
    markActivityViewsStale(session);
    markSentViewsStale(session);
    markSearchViewsStale(session);
    if (!channelId || !CHANNEL_ID.test(channelId))
      return Response.json({ accepted: true, channelId: null, ready: false });
    let ready = false;
    // Discovery snapshots follow accepted commands; wait before navigating to new channels.
    for (let attempt = 0; attempt < 10; attempt++) {
      const { metadata, roster } = await readChannelState(session, channelId);
      const value = (key: string) =>
        metadata?.tags.find((t) => t[0] === key)?.[1] ?? "";
      const keys =
        roster?.tags.filter((t) => t[0] === "p").map((t) => t[1]) ?? [];
      ready =
        input.action === "leave"
          ? !keys.includes(session.pubkey)
          : Boolean(metadata) && keys.includes(session.pubkey);
      if (input.action === "add")
        ready &&=
          keys.includes(input.pubkey) &&
          (!input.role ||
            roster?.tags.some(
              (t) =>
                t[0] === "p" && t[1] === input.pubkey && t[3] === input.role,
            ) === true);
      if (input.action === "remove") ready &&= !keys.includes(input.pubkey);
      if (input.action === "update")
        ready &&= Object.entries(input.changes).every(([key, v]) =>
          key === "visibility"
            ? metadata?.tags.some(
                (t) => t[0] === (v === "private" ? "private" : "public"),
              )
            : key === "archived"
              ? (value(key) === "true") === (v === "true")
              : value(key) === v,
        );
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    invalidateConversationViews(session);
    invalidateMemberViews(session, channelId);
    return Response.json({ accepted: true, channelId, ready });
  } catch (e) {
    if (accepted)
      return Response.json({ accepted: true, channelId, ready: false });
    return fail(e);
  }
}
