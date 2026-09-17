"use client";

import { ArrowUp, LoaderCircle, X } from "lucide-react";
import { useRef, useState, useTransition } from "react";

import {
  loadSigningCredential,
  makeMessageEvent,
  makeTypingEvent,
} from "@/client/identity";
import { TYPING_SEND_INTERVAL_MS } from "@/shared/typing";
import { TypingIndicator, type TypingParticipant } from "@/ui/TypingIndicator";

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

export function Composer({
  channelId,
  channelName,
  rootId = null,
  parentId = null,
  replyingTo = null,
  cancelReply,
  onSent,
  forum = false,
  expectedPubkey,
  typingParticipants = [],
  typingThreadHeadId = null,
}: {
  channelId: string;
  channelName: string;
  rootId?: string | null;
  parentId?: string | null;
  replyingTo?: string | null;
  cancelReply?: () => void;
  onSent?: () => void;
  forum?: boolean;
  expectedPubkey: string;
  typingParticipants?: TypingParticipant[];
  typingThreadHeadId?: string | null;
}) {
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const lastTypingSentAt = useRef(0);

  const sendTyping = (value: string) => {
    const now = Date.now();
    if (
      forum ||
      !value.trim() ||
      now - lastTypingSentAt.current < TYPING_SEND_INTERVAL_MS
    ) {
      return;
    }
    lastTypingSentAt.current = now;
    void loadSigningCredential(expectedPubkey)
      .then((credential) => {
        if (!credential) return;
        const event = makeTypingEvent(credential, {
          channelId,
          threadHeadId: typingThreadHeadId,
          rootId,
        });
        return fetch("/api/typing", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event),
        });
      })
      .catch(() => undefined);
  };

  const send = () => {
    const message = content.trim();
    if (!message || pending) return;
    setError(null);
    startTransition(async () => {
      try {
        const credential = await loadSigningCredential(expectedPubkey);
        if (!credential) {
          await returnToLogin();
          return;
        }
        const event = makeMessageEvent(credential, {
          channelId,
          content: message,
          rootId,
          parentId,
          forum,
        });
        const response = await fetch("/api/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event),
        });
        if (response.status === 401) {
          window.location.assign(
            `/login?next=${encodeURIComponent(location.pathname + location.search)}`,
          );
          return;
        }
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(body?.error || "Message was not sent");
        }
        setContent("");
        lastTypingSentAt.current = 0;
        onSent?.();
        textarea.current?.focus();
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : "Message was not sent",
        );
      }
    });
  };

  return (
    <div className={rootId ? "composer composer-thread" : "composer"}>
      <TypingIndicator participants={typingParticipants} />
      {rootId && replyingTo ? (
        <div className="composer-reply-target">
          <span>
            Replying to <strong>{replyingTo}</strong>
          </span>
          <button aria-label="Cancel reply" onClick={cancelReply} type="button">
            <X aria-hidden="true" size={15} />
          </button>
        </div>
      ) : null}
      <div className="composer-box">
        <textarea
          aria-label={rootId ? "Reply to thread" : `Message ${channelName}`}
          disabled={pending}
          onChange={(event) => {
            setContent(event.target.value);
            sendTyping(event.target.value);
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (event.ctrlKey || event.metaKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              send();
            }
          }}
          placeholder={
            rootId && replyingTo
              ? `Reply to ${replyingTo}…`
              : rootId
                ? "Reply…"
                : `Message #${channelName}`
          }
          ref={textarea}
          rows={1}
          value={content}
        />
        <button
          aria-label="Send message"
          className="send-button"
          disabled={!content.trim() || pending}
          onClick={send}
          type="button"
        >
          {pending ? (
            <LoaderCircle aria-hidden="true" className="spin" size={17} />
          ) : (
            <ArrowUp aria-hidden="true" size={17} strokeWidth={2.6} />
          )}
        </button>
      </div>
      {error ? <p className="composer-error">{error}</p> : null}
      {!rootId ? (
        <p className="composer-hint">
          Signed in this browser · Enter for a new line · Ctrl/Cmd+Enter to send
        </p>
      ) : null}
    </div>
  );
}
