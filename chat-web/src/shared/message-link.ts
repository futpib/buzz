const CHANNEL_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_ID = /^[0-9a-f]{64}$/i;
const ALLOWED_PARAMETERS = new Set(["channel", "id", "thread"]);

export type ParsedMessageLink = {
  channelId: string;
  messageId: string;
  threadRootId: string | null;
};

/** Parse the canonical cross-client `buzz://message` shape. */
export function parseMessageLink(value: string): ParsedMessageLink | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "buzz:" ||
    url.hostname !== "message" ||
    url.pathname !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== ""
  ) {
    return null;
  }

  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_PARAMETERS.has(key)) return null;
  }
  for (const key of ALLOWED_PARAMETERS) {
    if (url.searchParams.getAll(key).length > 1) return null;
  }

  const channelId = url.searchParams.get("channel");
  const messageId = url.searchParams.get("id");
  const threadRootId = url.searchParams.get("thread");
  if (
    !channelId ||
    !CHANNEL_ID.test(channelId) ||
    !messageId ||
    !EVENT_ID.test(messageId) ||
    (threadRootId !== null && !EVENT_ID.test(threadRootId))
  ) {
    return null;
  }

  return {
    channelId: channelId.toLowerCase(),
    messageId: messageId.toLowerCase(),
    threadRootId: threadRootId?.toLowerCase() ?? null,
  };
}

/** Convert a message deep link into the equivalent authenticated web route. */
export function messageLinkRoute(link: ParsedMessageLink): string {
  return `/channels/${link.channelId}?${new URLSearchParams({
    thread: link.threadRootId ?? link.messageId,
    message: link.messageId,
  })}`;
}
