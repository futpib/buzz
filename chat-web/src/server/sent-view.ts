import { eventThreadTarget } from "@/server/event-navigation";
import { projectMessages } from "@/server/projector";
import type {
  ChannelView,
  NostrEvent,
  ProfileView,
  SentItemView,
} from "@/server/types";

function channelIdOf(event: NostrEvent): string | null {
  return (
    event.tags.find(
      (tag) => tag[0] === "h" && typeof tag[1] === "string",
    )?.[1] ?? null
  );
}

/** Build the viewer's newest visible authored messages across their channels. */
export function projectSentItems(
  events: NostrEvent[],
  channels: ChannelView[],
  profiles: Map<string, ProfileView>,
  viewerPubkey: string,
): SentItemView[] {
  const messagesById = new Map(events.map((event) => [event.id, event]));

  return channels
    .flatMap((channel) =>
      projectMessages(events, channel.id, profiles, viewerPubkey)
        .filter((message) => message.isOwn)
        .flatMap((message) => {
          const source = messagesById.get(message.id);
          if (!source || channelIdOf(source) !== channel.id) return [];
          return [
            {
              id: message.id,
              channel,
              threadId: eventThreadTarget(source),
              message,
            },
          ];
        }),
    )
    .sort(
      (a, b) =>
        b.message.createdAt - a.message.createdAt || a.id.localeCompare(b.id),
    );
}
