"use client";

import { ArrowUpRight } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

import type { ChannelView, ProfileView, ReactionView } from "@/server/types";
import { Avatar } from "@/ui/Avatar";
import { MessageBody } from "@/ui/MessageBody";
import { ViewLink } from "@/ui/ViewLink";

type ArticleProps = Omit<ComponentPropsWithoutRef<"article">, "children"> & {
  [key: `data-${string}`]: string | number | undefined;
};

export function MessageSurfaceCard({
  articleProps,
  author,
  channels,
  compact = false,
  content,
  createdAt,
  editedAt = null,
  footer,
  href,
  isOwn = false,
  labels = [],
  onOpen,
  openLabel = "Open message",
  reactions = [],
  timeLabel,
}: {
  articleProps?: ArticleProps;
  author: ProfileView;
  channels: ChannelView[];
  compact?: boolean;
  content: string;
  createdAt: number;
  editedAt?: number | null;
  footer?: ReactNode;
  href?: string | null;
  isOwn?: boolean;
  labels?: string[];
  onOpen?: () => void;
  openLabel?: string;
  reactions?: ReactionView[];
  timeLabel: ReactNode;
}) {
  const { className = "", ...rest } = articleProps ?? {};
  return (
    <article
      {...rest}
      aria-label={articleProps?.["aria-label"] ?? `Message from ${author.name}`}
      className={`message-row message-surface-row${compact ? " message-row-compact" : ""}${className ? ` ${className}` : ""}`}
    >
      <Avatar profile={author} small={compact} />
      <div className="message-content">
        <div className="message-meta">
          <strong>{author.name}</strong>
          {isOwn ? <span className="you-label">you</span> : null}
          {labels.map((label) => (
            <span key={label}>{label}</span>
          ))}
          <time dateTime={new Date(createdAt * 1_000).toISOString()}>
            {timeLabel}
          </time>
          {editedAt ? <span>edited</span> : null}
        </div>
        <MessageBody channels={channels} content={content} />
        {reactions.length > 0 ? (
          <ul className="reaction-list" aria-label="Reactions">
            {reactions.map((reaction) => (
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
        {footer || href ? (
          <div className="message-surface-footer">
            <span className="message-surface-detail">{footer}</span>
            {href ? (
              <ViewLink
                className="message-surface-open"
                href={href}
                onClick={onOpen}
                scroll={false}
              >
                {openLabel}
                <ArrowUpRight aria-hidden="true" size={13} />
              </ViewLink>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}
