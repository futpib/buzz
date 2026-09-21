"use client";

import { MessageCircle, MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  isMessageForcedUnread,
  isThreadFollowed,
  setMessageForcedUnread,
  setThreadFollowed,
} from "@/client/message-context-state";
import type { ChannelView, MessageView } from "@/server/types";
import { Avatar } from "@/ui/Avatar";
import { MessageBody } from "@/ui/MessageBody";
import { MessageContextMenu } from "@/ui/MessageContextMenu";
import { ViewLink } from "@/ui/ViewLink";

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_PX = 12;

type MenuState = { x: number; y: number };

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
  onContextReply = onReply,
  replyingTo,
  highlighted = false,
  expectedPubkey,
  onMessageChange,
  channels,
}: {
  message: MessageView;
  channelId: string;
  compact?: boolean;
  hideThreadLink?: boolean;
  onReply?: () => void;
  onContextReply?: () => void;
  replyingTo?: string | null;
  highlighted?: boolean;
  expectedPubkey: string;
  onMessageChange: (message: MessageView | null) => void;
  channels: ChannelView[];
}) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [isUnread, setIsUnread] = useState(false);
  const [isFollowing, setIsFollowing] = useState(false);
  const longPress = useRef<{
    pointerId: number;
    x: number;
    y: number;
    timer: number;
  } | null>(null);
  const suppressClick = useRef(false);
  const threadFollowId = message.threadRootId ?? message.id;

  useEffect(() => {
    setIsUnread(isMessageForcedUnread(expectedPubkey, message.id));
    setIsFollowing(isThreadFollowed(expectedPubkey, threadFollowId));
  }, [expectedPubkey, message.id, threadFollowId]);

  const cancelLongPress = () => {
    if (longPress.current) window.clearTimeout(longPress.current.timer);
    longPress.current = null;
  };
  const openMenu = (x: number, y: number) => {
    cancelLongPress();
    setMenu({ x, y });
  };
  const closeMenu = () => {
    setMenu(null);
  };

  return (
    <article
      aria-label={`Message from ${message.author.name}`}
      className={`${compact ? "message-row message-row-compact" : "message-row"}${highlighted ? " message-row-highlighted" : ""}${isUnread ? " message-row-unread" : ""}`}
      data-message-id={message.id}
      onClickCapture={(event) => {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        openMenu(event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (
          event.key !== "ContextMenu" &&
          !(event.key === "F10" && event.shiftKey)
        ) {
          return;
        }
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        openMenu(rect.right, rect.top + Math.min(rect.height / 2, 36));
      }}
      onPointerCancel={cancelLongPress}
      onPointerDownCapture={(event) => {
        if (
          (event.pointerType !== "touch" && event.pointerType !== "pen") ||
          !event.isPrimary
        ) {
          return;
        }
        cancelLongPress();
        const pointerId = event.pointerId;
        const x = event.clientX;
        const y = event.clientY;
        const timer = window.setTimeout(() => {
          if (longPress.current?.pointerId !== pointerId) return;
          suppressClick.current = true;
          navigator.vibrate?.(12);
          openMenu(x, y);
        }, LONG_PRESS_MS);
        longPress.current = { pointerId, x, y, timer };
      }}
      onPointerMoveCapture={(event) => {
        const press = longPress.current;
        if (!press || press.pointerId !== event.pointerId) return;
        if (
          Math.hypot(event.clientX - press.x, event.clientY - press.y) >
          LONG_PRESS_MOVE_PX
        ) {
          cancelLongPress();
        }
      }}
      onPointerUpCapture={cancelLongPress}
    >
      <Avatar profile={message.author} small={compact} />
      <div className="message-content">
        <div className="message-meta">
          <strong>{message.author.name}</strong>
          {message.isOwn ? <span className="you-label">you</span> : null}
          <MessageTime timestamp={message.createdAt} />
          {message.editedAt ? <span>edited</span> : null}
        </div>
        <button
          aria-label={`Actions for message from ${message.author.name}`}
          className="message-menu-trigger"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            openMenu(rect.right, rect.bottom);
          }}
          type="button"
        >
          <MoreHorizontal aria-hidden="true" size={17} />
        </button>
        {replyingTo ? (
          <p className="message-reply-context">Replying to {replyingTo}</p>
        ) : null}
        <MessageBody channels={channels} content={message.content} />
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
      {menu ? (
        <MessageContextMenu
          channelId={channelId}
          close={closeMenu}
          expectedPubkey={expectedPubkey}
          isFollowing={isFollowing}
          isUnread={isUnread}
          message={message}
          onChange={onMessageChange}
          onFollowChange={(following) => {
            setIsFollowing(
              setThreadFollowed(expectedPubkey, threadFollowId, following),
            );
          }}
          onReply={onContextReply}
          onUnreadChange={(unread) => {
            setIsUnread(
              setMessageForcedUnread(expectedPubkey, message.id, unread),
            );
          }}
          point={menu}
        />
      ) : null}
    </article>
  );
}
