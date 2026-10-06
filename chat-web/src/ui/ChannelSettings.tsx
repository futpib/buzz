"use client";
import { useEffect, useState } from "react";
import type {
  ConversationAction,
  ConversationDetails,
} from "@/shared/conversations";
import type { ConversationResult } from "@/client/conversations";
function fields(detail: ConversationDetails) {
  return {
    name: detail.channel.name,
    about: detail.about,
    topic: detail.topic,
    purpose: detail.purpose,
    visibility: detail.channel.visibility === "private" ? "private" : "open",
    ttl: detail.ttl,
  };
}
export function ChannelSettings({
  detail,
  busy,
  run,
}: {
  detail: ConversationDetails;
  busy: boolean;
  run: (input: ConversationAction) => Promise<ConversationResult | null>;
}) {
  const [draft, setDraft] = useState(() => fields(detail)),
    [dirty, setDirty] = useState(false);
  const [edited, setEdited] = useState<string[]>([]);
  useEffect(() => {
    if (!dirty) setDraft(fields(detail));
  }, [detail, dirty]);
  if (detail.channel.type === "dm")
    return (
      <p>
        Direct messages are private conversations. Their participants are listed
        under Members.
      </p>
    );
  const change = (key: string, value: string) => {
    setDirty(true);
    setEdited((current) =>
      current.includes(key) ? current : [...current, key],
    );
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const previous = fields(detail);
  const changes = Object.fromEntries(
    Object.entries(draft).filter(
      ([key, value]) =>
        edited.includes(key) &&
        value !== previous[key as keyof typeof previous] &&
        (detail.canManage || key === "topic" || key === "purpose"),
    ),
  );
  return (
    <>
      {!detail.canManage ? (
        <p>
          Owners and admins manage channel settings. Members can edit the topic
          and purpose.
        </p>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run({
            action: "update",
            channelId: detail.channel.id,
            changes,
          }).then((result) => {
            if (result?.ready) {
              setDirty(false);
              setEdited([]);
            }
          });
        }}
      >
        {(
          [
            ["name", "Channel name"],
            ["about", "Description"],
            ["topic", "Topic"],
            ["purpose", "Purpose"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} htmlFor={`channel-setting-${key}`}>
            {label}
            {key === "name" ? (
              <input
                id={`channel-setting-${key}`}
                aria-label={label}
                value={draft[key]}
                maxLength={100}
                required
                disabled={busy || !detail.canManage || detail.channel.archived}
                onChange={(e) => change(key, e.target.value)}
              />
            ) : (
              <textarea
                id={`channel-setting-${key}`}
                aria-label={label}
                value={draft[key]}
                maxLength={8000}
                disabled={
                  busy ||
                  detail.channel.archived ||
                  (!detail.canManage && key === "about")
                }
                onChange={(e) => change(key, e.target.value)}
              />
            )}
          </label>
        ))}
        {detail.canManage ? (
          <>
            <label>
              Visibility
              <select
                aria-label="Visibility"
                value={draft.visibility}
                disabled={busy || detail.channel.archived}
                onChange={(e) => change("visibility", e.target.value)}
              >
                <option value="open">
                  Open — anyone in this community can join
                </option>
                <option value="private">Private — invitation required</option>
              </select>
            </label>
            <label>
              Auto-archive after inactivity (seconds)
              <input
                type="number"
                min="1"
                max="2147483647"
                value={draft.ttl}
                placeholder="Never"
                disabled={busy || detail.channel.archived}
                onChange={(e) => change("ttl", e.target.value)}
              />
            </label>
            <small>Leave empty to keep the channel indefinitely.</small>
          </>
        ) : null}
        <button
          type="submit"
          className="primary-button"
          disabled={
            busy || Object.keys(changes).length === 0 || detail.channel.archived
          }
        >
          Save settings
        </button>
      </form>
      <div className="conversation-danger">
        {detail.canManage ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  `${detail.channel.archived ? "Restore" : "Archive"} ${detail.channel.name}?`,
                )
              )
                void run({
                  action: "update",
                  channelId: detail.channel.id,
                  changes: { archived: String(!detail.channel.archived) },
                });
            }}
          >
            {detail.channel.archived ? "Restore channel" : "Archive channel"}
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy || !detail.canLeave}
          onClick={() => {
            if (
              window.confirm(
                `Leave ${detail.channel.name}? ${detail.channel.visibility === "private" ? "You will need an invitation to return." : "You can rejoin from Browse channels."}`,
              )
            )
              void run({ action: "leave", channelId: detail.channel.id });
          }}
        >
          Leave channel
        </button>
        {!detail.canLeave ? (
          <small>
            Add another owner in Members before leaving this channel.
          </small>
        ) : null}
      </div>
    </>
  );
}
