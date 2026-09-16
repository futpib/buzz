import { MessageCircle } from "lucide-react";

import type { MessageView } from "@/server/types";
import { Avatar } from "@/ui/Avatar";
import { MessageBody } from "@/ui/MessageBody";
import { ViewLink } from "@/ui/ViewLink";

function MessageTime({ timestamp }: { timestamp: number }) {
  const date = new Date(timestamp * 1000);
  return (
    <time dateTime={date.toISOString()} suppressHydrationWarning>
      {date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
    </time>
  );
}

export function MessageRow({
  message,
  channelId,
  compact = false,
  hideThreadLink = false,
  onReply,
  replyingTo,
}: {
  message: MessageView;
  channelId: string;
  compact?: boolean;
  hideThreadLink?: boolean;
  onReply?: () => void;
  replyingTo?: string | null;
}) {
  return (
    <article
      className={compact ? "message-row message-row-compact" : "message-row"}
    >
      <Avatar profile={message.author} small={compact} />
      <div className="message-content">
        <div className="message-meta">
          <strong>{message.author.name}</strong>
          {message.isOwn ? <span className="you-label">you</span> : null}
          <MessageTime timestamp={message.createdAt} />
          {message.editedAt ? <span>edited</span> : null}
        </div>
        {replyingTo ? (
          <p className="message-reply-context">Replying to {replyingTo}</p>
        ) : null}
        <MessageBody content={message.content} />
        {message.reactions.length > 0 ? (
          <ul className="reaction-list" aria-label="Reactions">
            {message.reactions.map((reaction) => (
              <li
                className={
                  reaction.reactedByMe ? "reaction reaction-own" : "reaction"
                }
                key={reaction.emoji}
              >
                {reaction.emoji} {reaction.count}
              </li>
            ))}
          </ul>
        ) : null}
        {!hideThreadLink && message.replyCount > 0 ? (
          <ViewLink
            aria-label={`${message.replyCount} ${message.replyCount === 1 ? "reply" : "replies"} to ${message.author.name}`}
            className={
              compact ? "thread-link thread-link-nested" : "thread-link"
            }
            data-nested-thread-id={compact ? message.id : undefined}
            href={`/channels/${channelId}?thread=${message.id}`}
            scroll={false}
          >
            {compact && message.replyParticipants.length > 0 ? (
              <span className="thread-participants" aria-hidden="true">
                {message.replyParticipants.map((participant) => (
                  <Avatar
                    key={participant.pubkey}
                    profile={participant}
                    small
                  />
                ))}
              </span>
            ) : (
              <MessageCircle aria-hidden="true" size={14} strokeWidth={2.2} />
            )}
            <span>
              {message.replyCount}{" "}
              {message.replyCount === 1 ? "reply" : "replies"}
            </span>
          </ViewLink>
        ) : null}
        {onReply ? (
          <button
            className={
              !hideThreadLink && message.replyCount > 0
                ? "message-reply-action message-reply-action-after-thread"
                : "message-reply-action"
            }
            onClick={onReply}
            type="button"
          >
            <MessageCircle aria-hidden="true" size={13} strokeWidth={2.2} />
            Reply
          </button>
        ) : null}
      </div>
    </article>
  );
}
