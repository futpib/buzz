"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent, RefObject } from "react";
import { fetchView } from "@/client/fetch-view";
import type { ProfileView } from "@/server/types";
import {
  historicalMentions,
  mentionLabel,
  mentionQuery,
  resolveMentions,
  resolveEditedMentions,
  type MentionMember,
  type MentionRef,
} from "@/shared/mentions";

type MembersView = {
  members: ProfileView[];
  generatedAt: number;
  cacheState: string;
};
const cached = new Map<string, MembersView>();
const pending = new Map<string, Promise<MembersView>>();

async function getMembers(
  channel: string,
  identity: string,
  fresh: boolean,
): Promise<MembersView> {
  const key = `${identity}:${channel}`;
  const stored = cached.get(key);
  if (!fresh && stored && Date.now() - stored.generatedAt < 30_000)
    return stored;
  const requestKey = `${key}:${fresh}`;
  let request = pending.get(requestKey);
  if (!request) {
    request = fetchView<MembersView>(
      `/api/channels/${channel}/members${fresh ? "?fresh=1" : ""}`,
      identity,
      AbortSignal.timeout(30_000),
    )
      .then((view) => {
        if (
          !cached.has(key) ||
          view.generatedAt >= (cached.get(key)?.generatedAt ?? 0)
        ) {
          cached.delete(key);
          cached.set(key, view);
          if (cached.size > 64)
            cached.delete(cached.keys().next().value as string);
        }
        return view;
      })
      .finally(() => pending.delete(requestKey));
    pending.set(requestKey, request);
  }
  return request;
}

/** Shared mention controller for plain-text composition and message edits. */
export function useMentions(input: {
  channelId: string;
  identity: string;
  content: string;
  onChange: (content: string) => void;
  textarea: RefObject<HTMLTextAreaElement | null>;
  originalContent?: string;
  originalPubkeys?: string[];
}) {
  const {
    channelId,
    identity,
    content,
    onChange,
    textarea,
    originalContent,
    originalPubkeys,
  } = input;
  const key = `${identity}:${channelId}`;
  const [view, setView] = useState<MembersView | null>(
    () => cached.get(key) ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState<ReturnType<typeof mentionQuery>>(null);
  const [active, setActive] = useState(0);
  const selected = useRef<MentionRef[]>([]);
  const historical = useRef<MentionRef[] | null>(null);
  const mountedKey = useRef(key);
  const generation = useRef(0);
  const id = useId();
  const insertion = useRef<{ content: string; position: number } | null>(null);
  useLayoutEffect(() => {
    const pending = insertion.current;
    if (!pending || content !== pending.content) return;
    insertion.current = null;
    textarea.current?.focus();
    textarea.current?.setSelectionRange(pending.position, pending.position);
  }, [content, textarea]);
  const members = view?.members ?? [];
  const choices = query
    ? members
        .filter(
          (member) =>
            member.name.toLowerCase().includes(query.query.toLowerCase()) ||
            member.pubkey.startsWith(query.query.toLowerCase()),
        )
        .slice(0, 12)
    : [];
  const open = query !== null;

  useEffect(() => {
    mountedKey.current = key;
    selected.current = [];
    historical.current = null;
    setView(cached.get(key) ?? null);
    setQuery(null);
    setError(null);
    return () => {
      mountedKey.current = "";
      generation.current++;
    };
  }, [key]);

  const load = async (fresh = false) => {
    const attempt = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      let next = await getMembers(channelId, identity, fresh);
      if (mountedKey.current !== key || attempt !== generation.current) return;
      setView(next);
      if (next.cacheState === "stale") {
        next = await getMembers(channelId, identity, true);
        if (mountedKey.current !== key || attempt !== generation.current)
          return;
        setView(next);
      }
    } catch (caught) {
      if (mountedKey.current === key && attempt === generation.current)
        setError(
          caught instanceof Error ? caught.message : "Could not load members",
        );
    } finally {
      if (mountedKey.current === key && attempt === generation.current)
        setBusy(false);
    }
  };

  const updateQuery = (text: string, caret: number) => {
    const next = mentionQuery(text, caret);
    const completed =
      next &&
      selected.current.some((ref) => {
        const literal = `@${ref.displayName} `;
        return text
          .slice(next.start, caret)
          .toLowerCase()
          .startsWith(literal.toLowerCase());
      });
    setQuery(completed ? null : next);
    setActive(0);
  };
  const pick = (member: MentionMember) => {
    if (!query) return;
    const label = mentionLabel(member, members, selected.current);
    selected.current = [
      ...selected.current.filter(
        (ref) => ref.displayName.toLowerCase() !== label.toLowerCase(),
      ),
      { pubkey: member.pubkey, displayName: label },
    ];
    const caret = textarea.current?.selectionStart ?? content.length;
    const next = `${content.slice(0, query.start)}@${label} ${content.slice(caret)}`;
    const position = query.start + label.length + 2;
    insertion.current = { content: next, position };
    onChange(next);
    setQuery(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (
      !open ||
      event.nativeEvent.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return false;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setQuery(null);
      return true;
    }
    if (
      choices.length &&
      (event.key === "ArrowDown" || event.key === "ArrowUp")
    ) {
      event.preventDefault();
      event.stopPropagation();
      setActive(
        (current) =>
          (current + (event.key === "ArrowDown" ? 1 : choices.length - 1)) %
          choices.length,
      );
      return true;
    }
    if (
      choices.length &&
      (event.key === "Enter" || (event.key === "Tab" && !event.shiftKey))
    ) {
      event.preventDefault();
      event.stopPropagation();
      pick(choices[active % choices.length]);
      return true;
    }
    return false;
  };
  const resolve = async (): Promise<string[]> => {
    if (!content.includes("@")) return [];
    // Fresh names resolve typed input; explicit selections remain bound across renames.
    const next = await getMembers(channelId, identity, true);
    if (mountedKey.current !== key)
      throw new Error("The conversation changed. Please send again.");
    setView(next);
    if (historical.current === null)
      historical.current = historicalMentions(
        originalContent ?? "",
        originalPubkeys ?? [],
        next.members,
      );
    return originalContent !== undefined
      ? resolveEditedMentions(
          content,
          next.members,
          selected.current,
          { content: originalContent, pubkeys: originalPubkeys ?? [] },
          historical.current,
        )
      : [
          ...new Set(
            resolveMentions(content, next.members, selected.current).map(
              (ref) => ref.pubkey,
            ),
          ),
        ];
  };
  return {
    id,
    open,
    choices,
    active: choices.length ? active % choices.length : 0,
    busy,
    error,
    pick,
    load: () => {
      void load(true);
    },
    resolve,
    clear: () => {
      selected.current = [];
      historical.current = null;
      setQuery(null);
    },
    inputProps: {
      "aria-autocomplete": "list" as const,
      "aria-controls": open ? id : undefined,
      "aria-expanded": open,
      "aria-activedescendant":
        open && choices.length ? `${id}-${active % choices.length}` : undefined,
      onFocus: () => {
        void load();
      },
      onClick: () =>
        updateQuery(
          content,
          textarea.current?.selectionStart ?? content.length,
        ),
      onKeyUp: (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          updateQuery(
            content,
            textarea.current?.selectionStart ?? content.length,
          );
      },
      onBlur: (event: FocusEvent<HTMLTextAreaElement>) => {
        // Keep the form geometry stable between pointer-down and click on Save
        // or Send. Closing the list on that blur can move the clicked button.
        const group = event.currentTarget.closest(
          ".composer, .message-menu-form",
        );
        if (!group?.contains(event.relatedTarget)) setQuery(null);
      },
    },
    onChange: (text: string, caret: number) => {
      // Deleted labels cannot silently rebind a later manually typed occurrence.
      selected.current = selected.current.filter(
        (ref) =>
          historicalMentions(
            text,
            [ref.pubkey],
            [{ pubkey: ref.pubkey, name: ref.displayName }],
          ).length > 0,
      );
      onChange(text);
      updateQuery(text, caret);
    },
    onKeyDown,
  };
}
