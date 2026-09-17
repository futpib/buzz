export const TYPING_INDICATOR_KIND = 20_002;
export const TYPING_INDICATOR_TTL_MS = 8_000;
export const TYPING_SEND_INTERVAL_MS = 3_000;

const EVENT_ID = /^[0-9a-f]{64}$/i;

export function parseTypingScope(tags: string[][]): {
  valid: boolean;
  threadHeadId: string | null;
} {
  const references = tags.filter((tag) => tag[0] === "e");
  if (references.length === 0) return { valid: true, threadHeadId: null };
  if (
    references.length > 2 ||
    references.some(
      (tag) =>
        !EVENT_ID.test(tag[1] ?? "") ||
        (tag[3] !== "root" && tag[3] !== "reply"),
    )
  ) {
    return { valid: false, threadHeadId: null };
  }
  const roots = references.filter((tag) => tag[3] === "root");
  const replies = references.filter((tag) => tag[3] === "reply");
  if (
    roots.length > 1 ||
    replies.length !== 1 ||
    (references.length === 2 &&
      (roots.length !== 1 || roots[0][1] === replies[0][1]))
  ) {
    return { valid: false, threadHeadId: null };
  }
  return { valid: true, threadHeadId: replies[0][1] };
}
