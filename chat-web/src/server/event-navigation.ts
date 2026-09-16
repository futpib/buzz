import type { NostrEvent } from "@/server/types";

function eventReferences(event: NostrEvent): string[][] {
  return event.tags.filter(
    (tag) => tag[0] === "e" && typeof tag[1] === "string",
  );
}

/** Resolve the visible Android-style branch that contains an event. */
export function eventThreadTarget(event: NostrEvent): string {
  const references = eventReferences(event);
  const root = references.find((tag) => tag[3] === "root")?.[1];
  const reply = references.find((tag) => tag[3] === "reply")?.[1];
  if (root && reply && root !== reply) return reply;
  return root ?? reply ?? references[0]?.[1] ?? event.id;
}

/** Stable conversation identity used to group Inbox rows. */
export function eventConversationId(event: NostrEvent): string {
  const references = eventReferences(event);
  return (
    references.find((tag) => tag[3] === "root")?.[1] ??
    references.find((tag) => tag[3] === "reply")?.[1] ??
    references[0]?.[1] ??
    event.id
  );
}

export function eventHasThreadParent(event: NostrEvent): boolean {
  return eventReferences(event).length > 0;
}
