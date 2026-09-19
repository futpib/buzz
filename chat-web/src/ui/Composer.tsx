"use client";

import {
  ArrowUp,
  File,
  LoaderCircle,
  Paperclip,
  RotateCcw,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";

import { AttachmentUploadError, uploadAttachment } from "@/client/attachments";
import {
  loadSigningCredential,
  makeMessageEvent,
  makeTypingEvent,
} from "@/client/identity";
import {
  attachmentImetaTag,
  formatAttachmentBytes,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type MessageAttachment,
  messageContentWithAttachments,
  sanitizeAttachmentFilename,
} from "@/shared/attachments";
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

type QueuedAttachment = {
  id: string;
  file: globalThis.File;
  filename: string;
  status: "preparing" | "uploading" | "ready" | "error";
  progress: number;
  descriptor: MessageAttachment | null;
  error: string | null;
};

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
  const [attachments, setAttachments] = useState<QueuedAttachment[]>([]);
  const [pending, startTransition] = useTransition();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastTypingSentAt = useRef(0);
  const attachmentSequence = useRef(0);
  const uploadTail = useRef(Promise.resolve());
  const uploadControllers = useRef(new Map<string, AbortController>());

  useEffect(
    () => () => {
      for (const controller of uploadControllers.current.values()) {
        controller.abort();
      }
      uploadControllers.current.clear();
    },
    [],
  );

  const updateAttachment = (id: string, update: Partial<QueuedAttachment>) => {
    setAttachments((current) =>
      current.map((attachment) =>
        attachment.id === id ? { ...attachment, ...update } : attachment,
      ),
    );
  };

  const enqueueUpload = (attachment: QueuedAttachment) => {
    const controller = new AbortController();
    uploadControllers.current.set(attachment.id, controller);
    uploadTail.current = uploadTail.current
      .catch(() => undefined)
      .then(async () => {
        if (controller.signal.aborted) return;
        updateAttachment(attachment.id, {
          status: "preparing",
          progress: 0,
          error: null,
        });
        try {
          const credential = await loadSigningCredential(expectedPubkey);
          if (!credential) {
            await returnToLogin();
            return;
          }
          const descriptor = await uploadAttachment(
            attachment.file,
            credential,
            controller.signal,
            (status, progress) =>
              updateAttachment(attachment.id, { status, progress }),
          );
          updateAttachment(attachment.id, {
            status: "ready",
            progress: 1,
            descriptor: {
              ...descriptor,
              filename: attachment.filename,
            },
            error: null,
          });
        } catch (caught) {
          if (caught instanceof AttachmentUploadError && caught.loginRequired) {
            await returnToLogin();
            return;
          }
          if (caught instanceof DOMException && caught.name === "AbortError") {
            return;
          }
          updateAttachment(attachment.id, {
            status: "error",
            error:
              caught instanceof Error
                ? caught.message
                : "Attachment was not uploaded",
          });
        } finally {
          uploadControllers.current.delete(attachment.id);
        }
      });
  };

  const selectFiles = (files: FileList | null) => {
    if (!files?.length) return;
    const available = Math.max(
      0,
      MAX_ATTACHMENTS_PER_MESSAGE - attachments.length,
    );
    const selected = [...files].slice(0, available).map((file, index) => ({
      id: `${Date.now()}-${index}-${attachmentSequence.current++}`,
      file,
      filename: sanitizeAttachmentFilename(file.name),
      status: "preparing" as const,
      progress: 0,
      descriptor: null,
      error: null,
    }));
    if (selected.length < files.length) {
      setError(
        `A message can include up to ${MAX_ATTACHMENTS_PER_MESSAGE} files`,
      );
    } else {
      setError(null);
    }
    setAttachments((current) => [...current, ...selected]);
    for (const attachment of selected) enqueueUpload(attachment);
    if (fileInput.current) fileInput.current.value = "";
  };

  const removeAttachment = (id: string) => {
    uploadControllers.current.get(id)?.abort();
    uploadControllers.current.delete(id);
    setAttachments((current) =>
      current.filter((attachment) => attachment.id !== id),
    );
  };

  const retryAttachment = (attachment: QueuedAttachment) => {
    const retry = {
      ...attachment,
      status: "preparing",
      progress: 0,
      descriptor: null,
      error: null,
    } as const;
    updateAttachment(attachment.id, retry);
    enqueueUpload(retry);
  };

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
    const readyAttachments = attachments.flatMap((attachment) =>
      attachment.status === "ready" && attachment.descriptor
        ? [attachment.descriptor]
        : [],
    );
    const attachmentsSettled = readyAttachments.length === attachments.length;
    const message = messageContentWithAttachments(content, readyAttachments);
    if (!message || !attachmentsSettled || pending) return;
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
          imetaTags: readyAttachments.map(attachmentImetaTag),
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
        setAttachments([]);
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

  const hasUnreadyAttachment = attachments.some(
    (attachment) => attachment.status !== "ready",
  );
  const canSend =
    !pending &&
    !hasUnreadyAttachment &&
    (Boolean(content.trim()) || attachments.length > 0);

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
      {attachments.length ? (
        <ul aria-label="Attachments" className="composer-attachments">
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <File aria-hidden="true" size={16} />
              <div className="composer-attachment-info">
                <strong title={attachment.filename}>
                  {attachment.filename}
                </strong>
                <span>
                  {attachment.status === "preparing"
                    ? `Preparing ${Math.round(attachment.progress * 100)}%`
                    : attachment.status === "uploading"
                      ? `Uploading ${Math.round(attachment.progress * 100)}%`
                      : attachment.status === "ready"
                        ? formatAttachmentBytes(attachment.file.size)
                        : attachment.error || "Upload failed"}
                </span>
                {attachment.status === "preparing" ||
                attachment.status === "uploading" ? (
                  <progress
                    aria-label={`${attachment.filename} ${attachment.status}`}
                    max={1}
                    value={attachment.progress}
                  />
                ) : null}
              </div>
              {attachment.status === "error" ? (
                <button
                  aria-label={`Retry ${attachment.filename}`}
                  className="composer-attachment-action"
                  disabled={pending}
                  onClick={() => retryAttachment(attachment)}
                  title="Retry upload"
                  type="button"
                >
                  <RotateCcw aria-hidden="true" size={14} />
                </button>
              ) : null}
              <button
                aria-label={`Remove ${attachment.filename}`}
                className="composer-attachment-action"
                disabled={pending}
                onClick={() => removeAttachment(attachment.id)}
                title="Remove attachment"
                type="button"
              >
                <X aria-hidden="true" size={15} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="composer-box">
        <input
          hidden
          multiple
          onChange={(event) => selectFiles(event.target.files)}
          ref={fileInput}
          type="file"
        />
        <button
          aria-label="Attach files"
          className="attach-button"
          disabled={
            pending || attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE
          }
          onClick={() => fileInput.current?.click()}
          title="Attach files"
          type="button"
        >
          <Paperclip aria-hidden="true" size={17} />
        </button>
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
          disabled={!canSend}
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
