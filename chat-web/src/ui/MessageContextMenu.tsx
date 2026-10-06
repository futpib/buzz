"use client";

import {
  BellOff,
  BellRing,
  Clipboard,
  CornerUpLeft,
  Link2,
  LoaderCircle,
  MailCheck,
  MailOpen,
  Pencil,
  Pin,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";

import {
  loadSigningCredential,
  makeDeletionEvent,
  makeMessageEditEvent,
  makeReactionEvent,
  makePinEvent,
} from "@/client/identity";
import type { MessageView, NostrEvent, ReactionView } from "@/server/types";
import { ChannelPinsContext } from "@/ui/PinnedMessages";
import { EmojiReactionPicker } from "@/ui/EmojiReactionPicker";

import { useMentions } from "@/client/use-mentions";
import { MentionSuggestions } from "@/ui/MentionSuggestions";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "🔥"] as const;

type MenuPoint = { x: number; y: number };
type MenuMode = "actions" | "edit" | "delete";

export function messageLink(
  channelId: string,
  message: Pick<MessageView, "id" | "threadRootId">,
): string {
  const params = new URLSearchParams({ channel: channelId, id: message.id });
  if (message.threadRootId) params.set("thread", message.threadRootId);
  return `buzz://message?${params.toString()}`;
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const input = document.createElement("textarea");
    input.value = value;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    const copied = document.execCommand("copy");
    input.remove();
    if (!copied) throw new Error("Clipboard access was blocked");
  }
}

async function returnToLogin(): Promise<void> {
  await fetch("/api/auth/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).catch(() => undefined);
  window.location.assign(
    `/login?next=${encodeURIComponent(location.pathname + location.search)}`,
  );
}

async function publishAction(
  event: NostrEvent,
  channelId: string,
): Promise<void> {
  const response = await fetch("/api/message-actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, channelId }),
  });
  if (response.status === 401) {
    await returnToLogin();
    throw new Error("Login required");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error || "Message action failed");
  }
}

function optimisticReaction(
  reactions: ReactionView[],
  emoji: string,
  ownEventId: string | null,
): ReactionView[] {
  const current = reactions.find((reaction) => reaction.emoji === emoji);
  if (ownEventId) {
    if (current) {
      return reactions.map((reaction) =>
        reaction.emoji === emoji
          ? {
              ...reaction,
              count: reaction.count + (reaction.reactedByMe ? 0 : 1),
              reactedByMe: true,
              ownEventId,
            }
          : reaction,
      );
    }
    return [...reactions, { emoji, count: 1, reactedByMe: true, ownEventId }];
  }
  if (!current) return reactions;
  if (current.count <= 1) {
    return reactions.filter((reaction) => reaction.emoji !== emoji);
  }
  return reactions.map((reaction) =>
    reaction.emoji === emoji
      ? {
          emoji,
          count: reaction.count - 1,
          reactedByMe: false,
        }
      : reaction,
  );
}

export function MessageContextMenu({
  channelId,
  close,
  expectedPubkey,
  message,
  onChange,
  isFollowing,
  isUnread,
  onFollowChange,
  onUnreadChange,
  onReply,
  point,
}: {
  channelId: string;
  close: () => void;
  expectedPubkey: string;
  message: MessageView;
  onChange: (message: MessageView | null) => void;
  isFollowing: boolean;
  isUnread: boolean;
  onFollowChange: (following: boolean) => void;
  onUnreadChange: (unread: boolean) => void;
  onReply?: () => void;
  point: MenuPoint;
}) {
  const pins = useContext(ChannelPinsContext);
  const ownPinIds =
    pins.find((pin) => pin.message.id === message.id)?.ownPinIds ?? [];
  const [mode, setMode] = useState<MenuMode>("actions");
  const [expandedEmoji, setExpandedEmoji] = useState(false);
  const [editContent, setEditContent] = useState(message.content);
  const editTextarea = useRef<HTMLTextAreaElement>(null);
  const mentions = useMentions({
    channelId,
    identity: expectedPubkey,
    content: editContent,
    onChange: setEditContent,
    textarea: editTextarea,
    originalContent: message.content,
    originalPubkeys: message.mentionPubkeys,
  });
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const expandedEmojiRef = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    return () => {
      if (returnFocus.current?.isConnected) {
        returnFocus.current.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    const node = dialog.current;
    const first = node?.querySelector<HTMLElement>(
      mode === "edit" ? "textarea:not([disabled])" : "button:not([disabled])",
    );
    first?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (mode === "actions" && expandedEmojiRef.current) {
          expandedEmojiRef.current = false;
          setExpandedEmoji(false);
        } else if (mode === "actions") closeRef.current();
        else {
          setMode("actions");
          setError(null);
        }
        return;
      }
      if (event.key !== "Tab" || !node) return;
      const focusable = [
        ...node.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), textarea:not([disabled])",
        ),
      ];
      if (focusable.length === 0) return;
      const current = focusable.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? current <= 0
          ? focusable.length - 1
          : current - 1
        : current === focusable.length - 1
          ? 0
          : current + 1;
      event.preventDefault();
      focusable[next]?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [mode]);

  const run = async (name: string, action: () => Promise<void>) => {
    if (pending) return;
    setPending(name);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Message action failed",
      );
    } finally {
      setPending(null);
    }
  };

  const credential = async () => {
    const loaded = await loadSigningCredential(expectedPubkey);
    if (!loaded) {
      await returnToLogin();
      throw new Error("Login required");
    }
    return loaded;
  };

  const toggleReaction = (emoji: string) =>
    run("reaction", async () => {
      const existing = message.reactions.find(
        (reaction) => reaction.emoji === emoji && reaction.reactedByMe,
      );
      const signingCredential = await credential();
      if (existing?.ownEventId) {
        const event = makeDeletionEvent(signingCredential, {
          targetId: existing.ownEventId,
        });
        await publishAction(event, channelId);
        onChange({
          ...message,
          reactions: optimisticReaction(message.reactions, emoji, null),
        });
      } else {
        const event = makeReactionEvent(signingCredential, message.id, emoji);
        await publishAction(event, channelId);
        onChange({
          ...message,
          reactions: optimisticReaction(message.reactions, emoji, event.id),
        });
      }
      close();
    });

  const menuStyle = window.matchMedia("(max-width: 820px)").matches
    ? ({ right: 0, bottom: 0, left: 0 } satisfies CSSProperties)
    : ({
        left: Math.min(
          Math.max(12, point.x),
          Math.max(12, window.innerWidth - 300),
        ),
        top: Math.min(
          Math.max(12, point.y - 60),
          Math.max(12, window.innerHeight - 520),
        ),
      } satisfies CSSProperties);

  return createPortal(
    <div className="message-menu-layer">
      <button
        aria-label="Dismiss message actions"
        className="message-menu-backdrop"
        onClick={close}
        type="button"
      />
      <div
        aria-label="Message actions"
        aria-modal="true"
        className="message-menu-dialog"
        ref={dialog}
        role="dialog"
        style={menuStyle}
      >
        {mode === "actions" ? (
          <>
            <fieldset
              aria-label="Quick reactions"
              className="message-menu-reactions"
            >
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  aria-label={`React with ${emoji}`}
                  className={
                    message.reactions.some(
                      (reaction) =>
                        reaction.emoji === emoji && reaction.reactedByMe,
                    )
                      ? "selected"
                      : undefined
                  }
                  disabled={Boolean(pending)}
                  key={emoji}
                  onClick={() => void toggleReaction(emoji)}
                  type="button"
                >
                  {emoji}
                </button>
              ))}
              <button
                aria-controls="message-reaction-picker"
                aria-expanded={expandedEmoji}
                aria-label="More reactions"
                disabled={Boolean(pending)}
                onClick={() => {
                  const next = !expandedEmojiRef.current;
                  expandedEmojiRef.current = next;
                  setExpandedEmoji(next);
                }}
                type="button"
              >
                <Plus aria-hidden="true" size={20} />
              </button>
            </fieldset>
            {expandedEmoji ? (
              <div id="message-reaction-picker">
                <EmojiReactionPicker
                  disabled={Boolean(pending)}
                  onSelect={(emoji) => void toggleReaction(emoji)}
                />
              </div>
            ) : null}
            <div className="message-menu-actions" role="menu">
              <button
                disabled={Boolean(pending)}
                onClick={() =>
                  void run("pin", async () => {
                    const signer = await credential();
                    if (ownPinIds.length) {
                      for (const targetId of ownPinIds)
                        await publishAction(
                          makeDeletionEvent(signer, { channelId, targetId }),
                          channelId,
                        );
                    } else {
                      await publishAction(
                        makePinEvent(signer, {
                          channelId,
                          targetId: message.id,
                        }),
                        channelId,
                      );
                    }
                    close();
                  })
                }
                role="menuitem"
                type="button"
              >
                <Pin aria-hidden="true" size={19} />
                {ownPinIds.length ? "Remove my pin" : "Pin to channel"}
              </button>
              {onReply ? (
                <button
                  disabled={Boolean(pending)}
                  onClick={() => {
                    close();
                    onReply();
                  }}
                  role="menuitem"
                  type="button"
                >
                  <CornerUpLeft aria-hidden="true" size={19} />
                  Reply
                </button>
              ) : null}
              <button
                disabled={Boolean(pending)}
                onClick={() => {
                  onUnreadChange(!isUnread);
                  close();
                }}
                role="menuitem"
                type="button"
              >
                {isUnread ? (
                  <MailCheck aria-hidden="true" size={19} />
                ) : (
                  <MailOpen aria-hidden="true" size={19} />
                )}
                {isUnread ? "Mark read" : "Mark unread"}
              </button>
              {message.isOwn ? (
                <button
                  disabled={Boolean(pending)}
                  onClick={() => setMode("edit")}
                  role="menuitem"
                  type="button"
                >
                  <Pencil aria-hidden="true" size={19} />
                  Edit message
                </button>
              ) : null}
              <button
                disabled={Boolean(pending)}
                onClick={() =>
                  void run("copy", async () => {
                    await copyText(message.content);
                    close();
                  })
                }
                role="menuitem"
                type="button"
              >
                <Clipboard aria-hidden="true" size={19} />
                Copy text
              </button>
              <button
                disabled={Boolean(pending)}
                onClick={() =>
                  void run("link", async () => {
                    await copyText(messageLink(channelId, message));
                    close();
                  })
                }
                role="menuitem"
                type="button"
              >
                <Link2 aria-hidden="true" size={19} />
                Copy link
              </button>
              <button
                disabled={Boolean(pending)}
                onClick={() => {
                  onFollowChange(!isFollowing);
                  close();
                }}
                role="menuitem"
                type="button"
              >
                {isFollowing ? (
                  <BellOff aria-hidden="true" size={19} />
                ) : (
                  <BellRing aria-hidden="true" size={19} />
                )}
                {isFollowing ? "Unfollow thread" : "Follow thread"}
              </button>
              {message.isOwn ? (
                <div className="message-menu-separator" />
              ) : null}
              {message.isOwn ? (
                <button
                  className="destructive"
                  disabled={Boolean(pending)}
                  onClick={() => setMode("delete")}
                  role="menuitem"
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={19} />
                  Delete message
                </button>
              ) : null}
            </div>
          </>
        ) : null}

        {mode === "edit" ? (
          <form
            className="message-menu-form"
            onSubmit={(event) => {
              event.preventDefault();
              void run("edit", async () => {
                const signingCredential = await credential();
                const mentionPubkeys = await mentions.resolve();
                const action = makeMessageEditEvent(signingCredential, {
                  mentionPubkeys,
                  originalMentionPubkeys: message.mentionPubkeys,
                  channelId,
                  targetId: message.id,
                  content: editContent,
                });
                await publishAction(action, channelId);
                onChange({
                  ...message,
                  content: action.content,
                  mentionPubkeys,
                  editedAt: action.created_at,
                });
                close();
              });
            }}
          >
            <header>
              <h3>Edit message</h3>
              <button
                aria-label="Cancel edit"
                disabled={Boolean(pending)}
                onClick={() => setMode("actions")}
                type="button"
              >
                <X aria-hidden="true" size={18} />
              </button>
            </header>
            <MentionSuggestions mentions={mentions} />
            <textarea
              {...mentions.inputProps}
              ref={editTextarea}
              onKeyDown={(event) => {
                mentions.onKeyDown(event);
              }}
              aria-label="Message text"
              disabled={Boolean(pending)}
              maxLength={65_536}
              onChange={(event) =>
                mentions.onChange(
                  event.target.value,
                  event.target.selectionStart,
                )
              }
              rows={6}
              value={editContent}
            />
            <div className="message-menu-form-buttons">
              <button
                disabled={Boolean(pending)}
                onClick={() => setMode("actions")}
                type="button"
              >
                Cancel
              </button>
              <button
                disabled={!editContent.trim() || Boolean(pending)}
                type="submit"
              >
                {pending === "edit" ? (
                  <LoaderCircle aria-hidden="true" className="spin" size={16} />
                ) : null}
                Save
              </button>
            </div>
          </form>
        ) : null}

        {mode === "delete" ? (
          <div className="message-menu-form">
            <header>
              <h3>Delete message?</h3>
            </header>
            <p>This removes the message for everyone. This cannot be undone.</p>
            <div className="message-menu-form-buttons">
              <button
                disabled={Boolean(pending)}
                onClick={() => setMode("actions")}
                type="button"
              >
                Cancel
              </button>
              <button
                className="destructive"
                disabled={Boolean(pending)}
                onClick={() =>
                  void run("delete", async () => {
                    const signingCredential = await credential();
                    const action = makeDeletionEvent(signingCredential, {
                      channelId,
                      targetId: message.id,
                    });
                    await publishAction(action, channelId);
                    onChange(null);
                    close();
                  })
                }
                type="button"
              >
                {pending === "delete" ? (
                  <LoaderCircle aria-hidden="true" className="spin" size={16} />
                ) : (
                  <Trash2 aria-hidden="true" size={16} />
                )}
                Delete
              </button>
            </div>
          </div>
        ) : null}
        {error ? (
          <p aria-live="assertive" className="message-menu-error">
            {error}
          </p>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
