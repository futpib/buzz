import type { EmojiMartData } from "@emoji-mart/data";

export const DEFAULT_REACTION_EMOJIS = [
  "😀",
  "😅",
  "🥹",
  "😍",
  "🤔",
  "😮",
  "😢",
  "😡",
  "👏",
  "🙌",
  "🤝",
  "🙏",
  "💪",
  "👀",
  "💯",
  "✅",
  "🚀",
  "💡",
  "🎯",
  "❤️‍🔥",
] as const;

export type ReactionEmoji = {
  id: string;
  keywords: string[];
  name: string;
  native: string;
};

type EmojiScore = ReactionEmoji & {
  score: number;
  tier: number;
};

const separators = /[:_\s-]/gu;
const words = /[\s_-]+/u;
const emojiMarker = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u;

function collapseSeparators(value: string): string {
  return value.toLocaleLowerCase().replace(separators, "");
}

function subsequenceSpan(query: string, target: string): number | null {
  let first = -1;
  let last = -1;
  let queryIndex = 0;
  for (
    let targetIndex = 0;
    targetIndex < target.length && queryIndex < query.length;
    targetIndex += 1
  ) {
    if (target[targetIndex] !== query[queryIndex]) continue;
    if (first === -1) first = targetIndex;
    last = targetIndex;
    queryIndex += 1;
  }
  return queryIndex === query.length ? last - first : null;
}

function shortcodeScore(
  query: string,
  shortcode: string,
): Pick<EmojiScore, "score" | "tier"> | null {
  const normalizedQuery = collapseSeparators(query);
  const normalizedShortcode = collapseSeparators(shortcode);
  if (!normalizedQuery || !normalizedShortcode) return null;
  if (normalizedQuery === normalizedShortcode) return { tier: 0, score: 0 };
  if (normalizedShortcode.startsWith(normalizedQuery)) {
    return { tier: 1, score: 0 };
  }
  const substringIndex = normalizedShortcode.indexOf(normalizedQuery);
  if (substringIndex >= 0) return { tier: 3, score: substringIndex };
  const span = subsequenceSpan(normalizedQuery, normalizedShortcode);
  return span === null ? null : { tier: 5, score: span };
}

function keywordScore(
  query: string,
  emoji: ReactionEmoji,
): Pick<EmojiScore, "score" | "tier"> | null {
  const normalizedQuery = query.toLocaleLowerCase().trim();
  if (!normalizedQuery) return null;
  const candidates = [emoji.name, ...emoji.keywords].flatMap((candidate) =>
    candidate.split(words),
  );
  let best: Pick<EmojiScore, "score" | "tier"> | null = null;
  for (const [index, candidate] of candidates.entries()) {
    const normalized = candidate.toLocaleLowerCase();
    const tier = normalized.startsWith(normalizedQuery)
      ? 2
      : normalized.includes(normalizedQuery)
        ? 4
        : null;
    if (tier !== null && (!best || tier < best.tier)) {
      best = { tier, score: index };
    }
  }
  return best;
}

export function buildReactionEmojiIndex(data: EmojiMartData): ReactionEmoji[] {
  const index: ReactionEmoji[] = [];
  const seen = new Set<string>();
  for (const category of data.categories) {
    for (const id of category.emojis) {
      const record = data.emojis[id];
      const native = record?.skins[0]?.native;
      if (!record || !native || seen.has(native)) continue;
      seen.add(native);
      index.push({
        id: record.id || id,
        keywords: record.keywords ?? [],
        name: record.name || id,
        native,
      });
    }
  }
  return index;
}

export function searchReactionEmojis(
  index: ReactionEmoji[],
  query: string,
  limit = 60,
): ReactionEmoji[] {
  const trimmed = query.trim();
  if (!trimmed || limit <= 0) return [];
  const scored: EmojiScore[] = [];
  for (const emoji of index) {
    if (emoji.native === trimmed) {
      scored.push({ ...emoji, tier: 0, score: -1 });
      continue;
    }
    const shortcode = shortcodeScore(trimmed, emoji.id);
    const keyword = keywordScore(trimmed, emoji);
    const match =
      shortcode && keyword
        ? shortcode.tier <= keyword.tier
          ? shortcode
          : keyword
        : (shortcode ?? keyword);
    if (match) scored.push({ ...emoji, ...match });
  }
  return scored
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        a.score - b.score ||
        a.id.length - b.id.length ||
        a.id.localeCompare(b.id),
    )
    .slice(0, limit)
    .map(({ score: _score, tier: _tier, ...emoji }) => emoji);
}

export function defaultReactionEmojis(index: ReactionEmoji[]): ReactionEmoji[] {
  const byNative = new Map(index.map((emoji) => [emoji.native, emoji]));
  return DEFAULT_REACTION_EMOJIS.map(
    (native) =>
      byNative.get(native) ?? {
        id: native,
        keywords: [],
        name: native,
        native,
      },
  );
}

export function singleEmojiInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || !emojiMarker.test(trimmed)) return null;
  const segments = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
      trimmed,
    ),
  ];
  return segments.length === 1 ? trimmed : null;
}

let indexPromise: Promise<ReactionEmoji[]> | null = null;

export function loadReactionEmojiIndex(): Promise<ReactionEmoji[]> {
  indexPromise ??= import("@emoji-mart/data/sets/15/native.json").then(
    (module) => buildReactionEmojiIndex(module.default as EmojiMartData),
  );
  return indexPromise;
}
