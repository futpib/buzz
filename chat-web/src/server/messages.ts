import "server-only";

import { signEvent } from "@/server/nostr";
import { submitRelayEvent } from "@/server/relay";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_ID = /^[0-9a-f]{64}$/i;

export type SendMessageInput = {
  channelId: string;
  content: string;
  rootId?: string | null;
  forum?: boolean;
};

export async function publishMessage(input: SendMessageInput): Promise<string> {
  if (!UUID.test(input.channelId)) throw new Error("Invalid channel id");
  const content = input.content.trim();
  if (!content) throw new Error("Message cannot be empty");
  if (Buffer.byteLength(content, "utf8") > 64 * 1024) {
    throw new Error("Message is larger than 64 KiB");
  }
  if (input.rootId && !EVENT_ID.test(input.rootId)) {
    throw new Error("Invalid thread root id");
  }

  const tags: string[][] = [["h", input.channelId]];
  if (input.rootId) tags.push(["e", input.rootId, "", "reply"]);
  const kind = input.rootId
    ? input.forum
      ? 45003
      : 9
    : input.forum
      ? 45001
      : 9;
  const event = signEvent({
    kind,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content,
  });
  await submitRelayEvent(event);
  return event.id;
}
