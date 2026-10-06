"use client";

import type { useMentions } from "@/client/use-mentions";

/** Accessible keyboard and pointer suggestions, shared by composers and edits. */
export function MentionSuggestions({
  mentions,
}: {
  mentions: ReturnType<typeof useMentions>;
}) {
  if (!mentions.open) return null;
  return (
    <div className="mention-suggestions">
      <div className="mention-suggestions-heading">
        Mention a channel member{" "}
        {mentions.busy ? <span role="status">Updating…</span> : null}
      </div>
      {mentions.error ? (
        <div role="alert">
          {mentions.error}{" "}
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={mentions.load}
          >
            Retry
          </button>
        </div>
      ) : null}
      <div id={mentions.id} role="listbox" aria-label="Mention suggestions">
        {mentions.choices.map((member, index) => (
          <button
            id={`${mentions.id}-${index}`}
            key={member.pubkey}
            type="button"
            role="option"
            aria-selected={mentions.active === index}
            tabIndex={-1}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => mentions.pick(member)}
            title={member.pubkey}
          >
            <span>{member.name}</span>
            <small>
              {member.pubkey.slice(0, 8)}…{member.pubkey.slice(-4)}
            </small>
          </button>
        ))}
      </div>
      {!mentions.choices.length && !mentions.busy && !mentions.error ? (
        <p>No matching channel members.</p>
      ) : null}
    </div>
  );
}
