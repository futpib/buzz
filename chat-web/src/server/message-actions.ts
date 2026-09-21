import "server-only";

import type { AuthSession } from "@/server/auth";
import { validateMessageActionEvent } from "@/server/message-action-validation";
import type { NostrEvent } from "@/server/types";

export async function publishMessageAction(
  session: AuthSession,
  event: NostrEvent,
): Promise<string> {
  validateMessageActionEvent(session.pubkey, event);
  await session.relay.publish(event);
  return event.id;
}
