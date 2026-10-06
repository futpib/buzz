import { validateMentionMembers } from "@/server/members";
import "server-only";

import type { AuthSession } from "@/server/auth";
import { validateMessageEvent } from "@/server/message-validation";
import type { NostrEvent } from "@/server/types";

export async function publishMessage(
  session: AuthSession,
  event: NostrEvent,
): Promise<string> {
  validateMessageEvent(session.pubkey, event);
  await validateMentionMembers(session, event);
  await session.relay.publish(event);
  return event.id;
}
