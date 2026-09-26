import type { AuthSession } from "@/server/auth";
import type { TypingIndicatorView } from "@/server/types";
import { projectTypingIndicator } from "@/server/typing";
import {
  TYPING_INDICATOR_KIND,
  TYPING_INDICATOR_TTL_MS,
} from "@/shared/typing";

export function listenForChannelChanges(
  session: AuthSession,
  channelId: string,
  onDirty: (catchUp?: boolean) => void,
  onTyping: (typing: TypingIndicatorView) => void,
  signal: AbortSignal,
): Promise<void> {
  return session.relay.subscribe(
    {
      kinds: [
        5,
        7,
        9,
        9005,
        TYPING_INDICATOR_KIND,
        39005,
        40002,
        40003,
        40004,
        40008,
        45001,
        45003,
      ],
      "#h": [channelId],
      since:
        Math.floor(Date.now() / 1000) -
        Math.ceil(TYPING_INDICATOR_TTL_MS / 1_000),
    },
    {
      onEose() {
        // EOSE is also a reconciliation boundary when no recent event replayed.
        onDirty(true);
      },
      onEvent(event, isLive) {
        if (event.kind === TYPING_INDICATOR_KIND) {
          const typing = projectTypingIndicator(event, channelId);
          if (typing) onTyping(typing);
        } else if (isLive) {
          onDirty();
        }
      },
    },
    signal,
  );
}
