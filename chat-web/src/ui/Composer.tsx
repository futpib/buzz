"use client";

import { ArrowUp, LoaderCircle } from "lucide-react";
import { useRef, useState, useTransition } from "react";

import { loadCredential, makeMessageEvent } from "@/client/identity";

export function Composer({
  channelId,
  channelName,
  rootId = null,
  forum = false,
}: {
  channelId: string;
  channelName: string;
  rootId?: string | null;
  forum?: boolean;
}) {
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const textarea = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const message = content.trim();
    if (!message || pending) return;
    setError(null);
    startTransition(async () => {
      try {
        const credential = loadCredential();
        if (!credential) {
          throw new Error(
            "Your browser signing key is unavailable. Sign in again.",
          );
        }
        const event = makeMessageEvent(credential, {
          channelId,
          content: message,
          rootId,
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
      <div className="composer-box">
        <textarea
          aria-label={rootId ? "Reply to thread" : `Message ${channelName}`}
          disabled={pending}
          onChange={(event) => setContent(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          placeholder={rootId ? "Reply…" : `Message #${channelName}`}
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
          Signed in this browser · Enter to send · Shift+Enter for a new line
        </p>
      ) : null}
    </div>
  );
}
