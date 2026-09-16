"use client";

import { ImageOff, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import {
  encodeNostrAuthorization,
  loadCredential,
  makeMediaGetAuthEvent,
} from "@/client/identity";

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

export function AuthenticatedImage({
  src,
  alt,
  title,
}: {
  src: string;
  alt: string;
  title?: string;
}) {
  const target = protectedMediaUrl(src);
  const targetHref = target?.href ?? null;
  const targetHost = target?.host ?? null;
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!targetHref || !targetHost) return;
    setObjectUrl(null);
    setFailed(false);
    const controller = new AbortController();
    let allocated: string | null = null;
    const load = async () => {
      try {
        const credential = loadCredential();
        if (!credential) throw new Error("Browser signing key is unavailable");
        const event = makeMediaGetAuthEvent(credential, targetHost);
        const response = await fetch(
          `/api/media?${new URLSearchParams({ url: targetHref })}`,
          {
            cache: "no-store",
            headers: {
              "X-Buzz-Media-Authorization": encodeNostrAuthorization(event),
            },
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error("Media request failed");
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().startsWith("image/")) {
          throw new Error("Media response is not an image");
        }
        allocated = URL.createObjectURL(await response.blob());
        if (controller.signal.aborted) {
          URL.revokeObjectURL(allocated);
          allocated = null;
        } else {
          setObjectUrl(allocated);
        }
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    };
    void load();
    return () => {
      controller.abort();
      if (allocated) URL.revokeObjectURL(allocated);
    };
  }, [targetHref, targetHost]);

  if (!targetHref) {
    return (
      // biome-ignore lint/performance/noImgElement: message images use arbitrary authored URLs
      <img
        alt={alt}
        loading="lazy"
        referrerPolicy="no-referrer"
        src={src}
        title={title}
      />
    );
  }
  if (failed) {
    return (
      <span
        aria-label={alt || "Image unavailable"}
        className="message-image-state"
        role="img"
      >
        <ImageOff aria-hidden="true" size={18} /> Image unavailable
      </span>
    );
  }
  if (!objectUrl) {
    return (
      <span className="message-image-state" role="status">
        <LoaderCircle aria-hidden="true" className="spin" size={18} /> Loading
        image…
      </span>
    );
  }
  return (
    // biome-ignore lint/performance/noImgElement: authenticated object URLs cannot use next/image
    <img
      alt={alt}
      className="message-media-image"
      src={objectUrl}
      title={title}
    />
  );
}
