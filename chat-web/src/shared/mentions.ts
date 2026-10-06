import { mentionOccurrences } from "../../../desktop/src/shared/lib/mentionOccurrences";

export type MentionMember = { pubkey: string; name: string };
export type MentionRef = { pubkey: string; displayName: string };
export const PUBLIC_KEY = /^[0-9a-f]{64}$/;

/** Exact literal matches use the same boundaries and code exclusions as Desktop. */
export function resolveMentions(
  content: string,
  members: MentionMember[],
  selected: MentionRef[] = [],
): MentionRef[] {
  const explicit = new Map(
    selected.map((ref) => [ref.displayName.toLowerCase(), ref]),
  );
  const candidates = [
    ...selected,
    ...members
      .filter((member) => !explicit.has(member.name.toLowerCase()))
      .map((member) => ({ pubkey: member.pubkey, displayName: member.name })),
  ];
  const refs: MentionRef[] = [];
  for (const match of mentionOccurrences(content, candidates)) {
    const keys = new Set(match.candidates.map((candidate) => candidate.pubkey));
    if (keys.size !== 1)
      throw new Error(
        `@${match.candidates[0].displayName} matches more than one member. Choose a person from the mention suggestions.`,
      );
    const ref = match.candidates[0];
    if (!members.some((member) => member.pubkey === ref.pubkey)) {
      throw new Error(
        `@${ref.displayName} is no longer a channel member. Remove the mention or choose a current member.`,
      );
    }
    if (
      !refs.some(
        (item) =>
          item.pubkey === ref.pubkey && item.displayName === ref.displayName,
      )
    )
      refs.push(ref);
  }
  return refs;
}

/** Pick a literal label that cannot silently address a namesake. */
export function mentionLabel(
  member: MentionMember,
  members: MentionMember[],
  selected: MentionRef[],
): string {
  let label = member.name;
  const occupied = (name: string) =>
    [
      ...selected,
      ...members.map((item) => ({
        pubkey: item.pubkey,
        displayName: item.name,
      })),
    ].some(
      (item) =>
        item.pubkey !== member.pubkey &&
        item.displayName.toLowerCase() === name.toLowerCase(),
    );
  if (occupied(label)) label = `${member.name} (${member.pubkey})`;
  const base = label;
  for (let suffix = 2; occupied(label); suffix++) label = `${base} ${suffix}`;
  return label;
}

/** Hydrate only event-tagged identities; a key written in body text is not authority. */
export function historicalMentions(
  content: string,
  pubkeys: string[],
  members: MentionMember[],
): MentionRef[] {
  const candidates = members
    .filter((member) => pubkeys.includes(member.pubkey))
    .map((member) => ({ pubkey: member.pubkey, displayName: member.name }));
  for (const match of content.matchAll(
    /@([^@\r\n]+) \(([0-9a-f]{64})\)(?: ((?:[1-9][0-9]+|[2-9])))?/gi,
  )) {
    if (pubkeys.includes(match[2].toLowerCase()))
      candidates.push({
        pubkey: match[2].toLowerCase(),
        displayName: match[0].slice(1),
      });
  }
  return mentionOccurrences(content, candidates).flatMap((match) =>
    new Set(match.candidates.map((ref) => ref.pubkey)).size === 1
      ? [match.candidates[0]]
      : [],
  );
}

/** Locate the active @ query without interpreting email addresses or code as mentions. */
export function mentionQuery(
  content: string,
  caret: number,
): { start: number; query: string } | null {
  const prefix = content.slice(0, caret);
  const match = /(?:^|[\s(])@([^@\n\r]{0,120})$/.exec(prefix);
  if (!match) return null;
  const start = caret - match[1].length - 1;
  const probe = `${content.slice(0, start)}@BuzzMentionProbe ${content.slice(caret)}`;
  if (
    !mentionOccurrences(probe, [{ displayName: "BuzzMentionProbe" }]).some(
      (item) => item.start === start,
    )
  )
    return null;
  return { start, query: match[1] };
}

/** Validate notification recipients at the signing boundary. */
export function mentionTags(
  pubkeys: string[],
  author: string,
  tag = "p",
): string[][] {
  if (pubkeys.some((key) => !PUBLIC_KEY.test(key)))
    throw new Error("Mention public key is invalid");
  return [...new Set(pubkeys)]
    .filter((key) => tag !== "p" || key !== author)
    .map((key) => [tag, key]);
}

/** Preserve signed edit references without turning old unbound text into new notifications. */
export function resolveEditedMentions(
  content: string,
  members: MentionMember[],
  selected: MentionRef[],
  original: { content: string; pubkeys: string[] },
  historical = historicalMentions(original.content, original.pubkeys, members),
): string[] {
  const bindings = [
    ...selected,
    ...historical.filter(
      (ref) =>
        !selected.some(
          (item) =>
            item.displayName.toLowerCase() === ref.displayName.toLowerCase(),
        ),
    ),
  ];
  const refs = resolveMentions(content, members, bindings);
  const current = refs.filter(
    (ref) =>
      selected.some(
        (item) =>
          item.pubkey === ref.pubkey && item.displayName === ref.displayName,
      ) ||
      original.pubkeys.includes(ref.pubkey) ||
      !mentionOccurrences(original.content, [ref]).length,
  );
  const keys = current.map((ref) => ref.pubkey);
  // An unchanged unresolved historical label remains a non-notifying reference.
  // An explicit new selection must not also resurrect the old unknown identity.
  if (
    content === original.content &&
    !current.some((ref) => selected.some((item) => item.pubkey === ref.pubkey))
  )
    keys.push(...original.pubkeys);
  return [...new Set(keys)];
}
