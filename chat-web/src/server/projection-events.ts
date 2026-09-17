import type { RelayFilter } from "@/server/relay";
import type { NostrEvent } from "@/server/types";

export const CHANNEL_MESSAGE_KINDS = [9, 40002, 40008, 45001, 45003] as const;

const AUXILIARY_KINDS = [5, 7, 9005, 40003];
const AUXILIARY_DELETION_KINDS = [5, 9005];
const AUXILIARY_TARGET_CHUNK = 100;
const AUXILIARY_QUERY_LIMIT = 5_000;

export type RelayQuery = (filters: RelayFilter[]) => Promise<NostrEvent[]>;

function mergeEvents(...groups: NostrEvent[][]): NostrEvent[] {
  return [...new Map(groups.flat().map((event) => [event.id, event])).values()];
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function queryByTarget(
  query: RelayQuery,
  channelId: string,
  targetIds: string[],
  kinds: number[],
): Promise<NostrEvent[]> {
  const targets = [...new Set(targetIds)];
  if (targets.length === 0) return [];
  const groups: NostrEvent[][] = [];
  for (const targetGroup of chunks(targets, AUXILIARY_TARGET_CHUNK)) {
    groups.push(
      await query([
        {
          kinds,
          "#h": [channelId],
          "#e": targetGroup,
          limit: AUXILIARY_QUERY_LIMIT,
        },
      ]),
    );
  }
  return mergeEvents(...groups);
}

/**
 * Load the edits, reactions, and deletions needed to project a fixed message
 * set, including deletions of those auxiliary events. The caller does not
 * expose its view until both closure hops have completed.
 */
export async function loadProjectionAuxClosure(
  query: RelayQuery,
  channelId: string,
  messageIds: string[],
): Promise<NostrEvent[]> {
  const firstHop = await queryByTarget(
    query,
    channelId,
    messageIds,
    AUXILIARY_KINDS,
  );
  const secondHop = await queryByTarget(
    query,
    channelId,
    firstHop.map((event) => event.id),
    AUXILIARY_DELETION_KINDS,
  );
  return mergeEvents(firstHop, secondHop);
}

/**
 * Build the complete event set used by the all-channel Threads projection.
 * Page only durable message rows, then await their exact auxiliary closure.
 * This keeps the cache seed atomic without making the cursor walk unrelated
 * reaction history for the channel.
 */
export async function loadCompleteChannelProjection(
  query: RelayQuery,
  channelId: string,
  pageLimit = 500,
): Promise<NostrEvent[]> {
  const events = new Map<string, NostrEvent>();
  let until: number | undefined;
  let beforeId: string | undefined;
  for (;;) {
    const filter: RelayFilter = {
      kinds: [...CHANNEL_MESSAGE_KINDS],
      "#h": [channelId],
      limit: pageLimit,
    };
    if (until !== undefined && beforeId !== undefined) {
      filter.until = until;
      filter.before_id = beforeId;
    }
    const page = await query([filter]);
    for (const event of page) events.set(event.id, event);
    if (page.length < pageLimit) break;
    const tail = page.at(-1);
    if (
      !tail ||
      (until === tail.created_at && beforeId === tail.id) ||
      tail.created_at < 0
    ) {
      throw new Error(`Thread history pagination stalled for ${channelId}`);
    }
    until = tail.created_at;
    beforeId = tail.id;
  }
  const messages = [...events.values()];
  const auxiliary = await loadProjectionAuxClosure(
    query,
    channelId,
    messages.map((event) => event.id),
  );
  return mergeEvents(messages, auxiliary);
}
