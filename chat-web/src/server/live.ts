import "server-only";

import type { AuthSession } from "@/server/auth";

export function listenForChannelChanges(
  session: AuthSession,
  channelId: string,
  onDirty: () => void,
  signal: AbortSignal,
): Promise<void> {
  return session.relay.subscribe(
    {
      kinds: [5, 7, 9, 9005, 39005, 40002, 40003, 40008, 45001, 45003],
      "#h": [channelId],
      since: Math.floor(Date.now() / 1000) - 5,
    },
    onDirty,
    signal,
  );
}
