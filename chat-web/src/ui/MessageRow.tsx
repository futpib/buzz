import { MessageCircle } from "lucide-react";
import Link from "next/link";

import type { MessageView } from "@/server/types";
import { Avatar } from "@/ui/Avatar";
import { MessageBody } from "@/ui/MessageBody";

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
          <Link
            className="thread-link"
            href={`/channels/${channelId}?thread=${message.id}`}
            scroll={false}
          >
            <MessageCircle aria-hidden="true" size={14} strokeWidth={2.2} />
            {message.replyCount}{" "}
            {message.replyCount === 1 ? "reply" : "replies"}
          </Link>
        ) : null}
        {onReply ? (
          <button
            className="message-reply-action"
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
