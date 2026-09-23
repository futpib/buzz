"use client";

import { LoaderCircle, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  defaultReactionEmojis,
  loadReactionEmojiIndex,
  type ReactionEmoji,
  searchReactionEmojis,
  singleEmojiInput,
} from "@/client/reaction-emojis";

export function EmojiReactionPicker({
  disabled,
  onSelect,
}: {
  disabled: boolean;
  onSelect: (emoji: string) => void;
}) {
  const [index, setIndex] = useState<ReactionEmoji[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [query, setQuery] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void loadReactionEmojiIndex()
      .then((loaded) => {
        if (active) setIndex(loaded);
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    const frame = requestAnimationFrame(() =>
      searchInput.current?.focus({ preventScroll: true }),
    );
    return () => {
      active = false;
      cancelAnimationFrame(frame);
    };
  }, []);

  const trimmedQuery = query.trim();
  const directInput = singleEmojiInput(query);
  const matches = useMemo(
    () =>
      index
        ? trimmedQuery
          ? searchReactionEmojis(index, trimmedQuery)
          : defaultReactionEmojis(index)
        : [],
    [index, trimmedQuery],
  );
  const directIsListed = matches.some(({ native }) => native === directInput);
  const choices =
    directInput && !directIsListed
      ? [
          {
            id: "typed-emoji",
            keywords: [],
            name: "Typed emoji",
            native: directInput,
          },
          ...matches,
        ]
      : matches;

  const selectFirst = () => {
    const emoji = directInput ?? choices[0]?.native;
    if (emoji) onSelect(emoji);
  };

  return (
    <section aria-label="Emoji picker" className="message-menu-emoji-picker">
      <div className="message-menu-emoji-search">
        <Search aria-hidden="true" size={17} />
        <input
          aria-controls="message-menu-emoji-results"
          aria-label="Search emoji"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          disabled={disabled}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            selectFirst();
          }}
          placeholder="Search or paste emoji"
          ref={searchInput}
          spellCheck={false}
          type="search"
          value={query}
        />
        {query ? (
          <button
            aria-label="Clear emoji search"
            disabled={disabled}
            onClick={() => {
              setQuery("");
              searchInput.current?.focus();
            }}
            type="button"
          >
            <X aria-hidden="true" size={15} />
          </button>
        ) : null}
      </div>
      {index ? (
        choices.length > 0 ? (
          <fieldset
            aria-label={
              trimmedQuery ? "Emoji search results" : "More reactions"
            }
            className="message-menu-emoji-grid"
            id="message-menu-emoji-results"
          >
            {choices.map((emoji) => (
              <button
                aria-label={`React with ${emoji.name} ${emoji.native}`}
                disabled={disabled}
                key={`${emoji.id}-${emoji.native}`}
                onClick={() => onSelect(emoji.native)}
                title={`:${emoji.id}: — ${emoji.name}`}
                type="button"
              >
                {emoji.native}
              </button>
            ))}
          </fieldset>
        ) : (
          <p
            className="message-menu-emoji-status"
            id="message-menu-emoji-results"
          >
            No emoji found.
          </p>
        )
      ) : directInput ? (
        <fieldset
          aria-label="Typed emoji"
          className="message-menu-emoji-grid"
          id="message-menu-emoji-results"
        >
          <button
            aria-label={`React with typed emoji ${directInput}`}
            disabled={disabled}
            onClick={() => onSelect(directInput)}
            type="button"
          >
            {directInput}
          </button>
        </fieldset>
      ) : (
        <p
          aria-live="polite"
          className="message-menu-emoji-status"
          id="message-menu-emoji-results"
        >
          {loadFailed ? (
            "Emoji search unavailable. Paste one emoji to react."
          ) : (
            <>
              <LoaderCircle aria-hidden="true" className="spin" size={15} />
              Loading emoji…
            </>
          )}
        </p>
      )}
    </section>
  );
}
