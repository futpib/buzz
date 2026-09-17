import type { RelayFilter } from "@/server/relay";
import { projectTimeline } from "@/server/projector";
import type { ChannelTimelineCursor, NostrEvent } from "@/server/types";

export const CHANNEL_HISTORY_KINDS = [9, 40002, 40008, 45001, 45003] as const;

const AUXILIARY_KINDS = [5, 7, 9005, 40003];
const AUXILIARY_DELETION_KINDS = [5, 9005];
const AUXILIARY_TARGET_CHUNK = 1_000;
const AUXILIARY_QUERY_LIMIT = 5_000;

export type RelayQuery = (filters: RelayFilter[]) => Promise<NostrEvent[]>;

export type ChannelMessageWindow = {
  events: NostrEvent[];
  hasMore: boolean;
  nextCursor: ChannelTimelineCursor | null;
};

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
  channelIds: string[],
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
          "#h": channelIds,
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
  return loadProjectionAuxClosureForChannels(query, [channelId], messageIds);
}

export async function loadProjectionAuxClosureForChannels(
  query: RelayQuery,
  channelIds: string[],
  messageIds: string[],
): Promise<NostrEvent[]> {
  const firstHop = await queryByTarget(
    query,
    channelIds,
    messageIds,
    AUXILIARY_KINDS,
  );
  const secondHop = await queryByTarget(
    query,
    channelIds,
    firstHop.map((event) => event.id),
    AUXILIARY_DELETION_KINDS,
  );
  return mergeEvents(firstHop, secondHop);
}

/**
 * Build a top-level channel page over the standard WebSocket query surface.
 * The relay's native channel-window extension is HTTP-only, so this bounded
 * fallback scans raw messages. Decorations are fetched only for candidate
 * roots, not every reply crossed while finding them.
 */
export async function loadChannelMessageWindow(
  query: RelayQuery,
  channelId: string,
  viewerPubkey: string,
  cursor: ChannelTimelineCursor | null,
  windowLimit = 20,
  pageLimit = 1_000,
): Promise<ChannelMessageWindow> {
  const messages = new Map<string, NostrEvent>();
  const decorations = new Map<string, NostrEvent>();
  const decoratedRoots = new Set<string>();
  let scanCursor = cursor;

  for (;;) {
    const filter: RelayFilter = {
      kinds: [...CHANNEL_HISTORY_KINDS],
      "#h": [channelId],
      limit: pageLimit,
    };
    if (scanCursor) {
      filter.until = scanCursor.createdAt;
      filter.before_id = scanCursor.id;
    }
    const page = await query([filter]);
    for (const event of page) messages.set(event.id, event);

    const candidateRoots = projectTimeline(
      [...messages.values(), ...decorations.values()],
      channelId,
      new Map(),
      viewerPubkey,
    );
    const undecoratedRootIds = candidateRoots
      .map((root) => root.id)
      .filter((id) => !decoratedRoots.has(id));
    if (undecoratedRootIds.length > 0) {
      const closure = await loadProjectionAuxClosure(
        query,
        channelId,
        undecoratedRootIds,
      );
      for (const event of closure) decorations.set(event.id, event);
      for (const id of undecoratedRootIds) decoratedRoots.add(id);
    }

    const roots = projectTimeline(
      [...messages.values(), ...decorations.values()],
      channelId,
      new Map(),
      viewerPubkey,
    );
    const tail = page.at(-1);
    const scannedMore = page.length === pageLimit;
    if (roots.length >= windowLimit) {
      const oldestVisible = roots.at(-windowLimit);
      const hasMore = scannedMore || roots.length > windowLimit;
      return {
        events: mergeEvents([...messages.values()], [...decorations.values()]),
        hasMore,
        nextCursor:
          hasMore && oldestVisible
            ? { createdAt: oldestVisible.createdAt, id: oldestVisible.id }
            : null,
      };
    }
    if (!scannedMore) {
      return {
        events: mergeEvents([...messages.values()], [...decorations.values()]),
        hasMore: false,
        nextCursor: null,
      };
    }
    const nextCursor = tail
      ? { createdAt: tail.created_at, id: tail.id }
      : null;
    if (
      !nextCursor ||
      (scanCursor?.createdAt === nextCursor.createdAt &&
        scanCursor.id === nextCursor.id)
    ) {
      throw new Error(`Channel history pagination stalled for ${channelId}`);
    }
    scanCursor = nextCursor;
  }
}

/**
 * Build the complete message history used by the all-channel Threads
 * projection. Reactions and deletions are fetched separately: walking those
 * high-volume event kinds with the message cursor made cold Threads loads
 * scale with invisible auxiliary history.
 */
export async function loadCompleteChannelHistory(
  query: RelayQuery,
  channelId: string,
  pageLimit = 1_000,
): Promise<NostrEvent[]> {
  const events = new Map<string, NostrEvent>();
  let until: number | undefined;
  let beforeId: string | undefined;
  for (;;) {
    const filter: RelayFilter = {
      kinds: [...CHANNEL_HISTORY_KINDS],
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
  return [...events.values()];
}
