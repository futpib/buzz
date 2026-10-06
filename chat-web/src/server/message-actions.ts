import { validateMentionMembers } from "@/server/members";
import "server-only";

import type { AuthSession } from "@/server/auth";
import { validateMessageActionEvent } from "@/server/message-action-validation";
import type { NostrEvent } from "@/server/types";

export async function publishMessageAction(
  session: AuthSession,
  event: NostrEvent,
): Promise<string> {
  validateMessageActionEvent(session.pubkey, event);
  await validateMentionMembers(session, event);
  if (event.kind === 40004) {
    const channelId = event.tags.find((tag) => tag[0] === "h")?.[1] ?? "";
    const targetId = event.tags.find((tag) => tag[0] === "e")?.[1] ?? "";
    const targets = await session.relay.query([
      { ids: [targetId], "#h": [channelId], limit: 1 },
    ]);
    if (
      !targets.some(
        (target) =>
          target.id === targetId &&
          [9, 40002, 40008, 45001, 45003].includes(target.kind) &&
          target.tags.some((tag) => tag[0] === "h" && tag[1] === channelId),
      )
    ) {
      throw new Error("Pin target is not a message in this channel");
    }
  }
  await session.relay.publish(event);
  return event.id;
}
