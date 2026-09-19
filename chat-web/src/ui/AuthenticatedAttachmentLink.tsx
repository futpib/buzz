"use client";

import { Download, LoaderCircle } from "lucide-react";
import { type ReactNode, useState } from "react";

import {
  encodeNostrAuthorization,
  loadSigningCredential,
  makeMediaGetAuthEvent,
} from "@/client/identity";
import { sanitizeAttachmentFilename } from "@/shared/attachments";

const RELAY_MEDIA_PATH =
  /^\/media\/[0-9a-f]{64}(?:\.[a-z0-9]{1,8}|\.thumb\.jpg)?$/;

function protectedMediaUrl(src: string): URL | null {
  try {
    const url = new URL(src);
    return /^https?:$/.test(url.protocol) && RELAY_MEDIA_PATH.test(url.pathname)
      ? url
      : null;
  } catch {
    return null;
  }
}

function attachmentLabel(children: ReactNode): string {
  return sanitizeAttachmentFilename(
    typeof children === "string" || typeof children === "number"
      ? String(children)
      : "attachment",
  );
}

export function AuthenticatedAttachmentLink({
  href,
  title,
  children,
}: {
  href?: string;
  title?: string;
  children: ReactNode;
}) {
  const target = typeof href === "string" ? protectedMediaUrl(href) : null;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!target) {
    return (
      <a href={href} rel="noopener noreferrer" target="_blank" title={title}>
        {children}
      </a>
    );
  }

  const openAttachment = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    const viewer = window.open("about:blank", "_blank");
    if (viewer) viewer.opener = null;
    try {
      const credential = await loadSigningCredential();
      if (!credential) throw new Error("Browser signing key is unavailable");
      const event = makeMediaGetAuthEvent(credential, target.host);
      const response = await fetch(
        `/api/media?${new URLSearchParams({ url: target.href })}`,
        {
          cache: "no-store",
          headers: {
            "X-Buzz-Media-Authorization": encodeNostrAuthorization(event),
          },
        },
      );
      if (!response.ok) throw new Error("Attachment could not be loaded");
      const objectUrl = URL.createObjectURL(await response.blob());
      if (viewer) {
        viewer.location.replace(objectUrl);
      } else {
        const download = document.createElement("a");
        download.href = objectUrl;
        download.download = attachmentLabel(children);
        download.rel = "noopener noreferrer";
        download.target = "_blank";
        download.click();
      }
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (caught) {
      viewer?.close();
      setError(
        caught instanceof Error
          ? caught.message
          : "Attachment could not be loaded",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <span className="message-attachment">
      <button
        aria-label={`Open attachment in a new tab: ${attachmentLabel(children)}`}
        className="message-attachment-link"
        disabled={pending}
        onClick={openAttachment}
        title={title ?? "Open attachment in a new tab"}
        type="button"
      >
        {pending ? (
          <LoaderCircle aria-hidden="true" className="spin" size={14} />
        ) : (
          <Download aria-hidden="true" size={14} />
        )}
        {children}
      </button>
      {error ? (
        <span className="message-attachment-error" role="status">
          {error}
        </span>
      ) : null}
    </span>
  );
}
