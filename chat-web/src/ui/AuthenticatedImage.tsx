"use client";

import { ImageOff, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import {
  encodeNostrAuthorization,
  loadSigningCredential,
  makeMediaGetAuthEvent,
} from "@/client/identity";
import { ImageLightbox } from "@/ui/ImageLightbox";

const RELAY_MEDIA_PATH =
  /^\/media\/[0-9a-f]{64}(?:\.[a-z0-9]{1,8}|\.thumb\.jpg)?$/;
const protectedMediaCache = new Map<string, Promise<string>>();

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

function loadProtectedMedia(targetHref: string, targetHost: string) {
  const cached = protectedMediaCache.get(targetHref);
  if (cached) return cached;
  const request = (async () => {
    const credential = await loadSigningCredential();
    if (!credential) throw new Error("Browser signing key is unavailable");
    const event = makeMediaGetAuthEvent(credential, targetHost);
    const response = await fetch(
      `/api/media?${new URLSearchParams({ url: targetHref })}`,
      {
        cache: "no-store",
        headers: {
          "X-Buzz-Media-Authorization": encodeNostrAuthorization(event),
        },
      },
    );
    if (!response.ok) throw new Error("Media request failed");
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("image/")) {
      throw new Error("Media response is not an image");
    }
    return URL.createObjectURL(await response.blob());
  })().catch((error) => {
    protectedMediaCache.delete(targetHref);
    throw error;
  });
  protectedMediaCache.set(targetHref, request);
  return request;
}

export function AuthenticatedImage({
  src,
  alt,
  title,
  variant = "message",
}: {
  src: string;
  alt: string;
  title?: string;
  variant?: "avatar" | "message";
}) {
  const target = protectedMediaUrl(src);
  const targetHref = target?.href ?? null;
  const targetHost = target?.host ?? null;
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);

  useEffect(() => {
    if (!targetHref || !targetHost) return;
    setObjectUrl(null);
    setFailed(false);
    let active = true;
    void loadProtectedMedia(targetHref, targetHost).then(
      (url) => {
        if (active) setObjectUrl(url);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [targetHref, targetHost]);

  if (!targetHref) {
    const image = (
      // biome-ignore lint/performance/noImgElement: message images use arbitrary authored URLs
      <img
        alt={alt}
        className={variant === "avatar" ? "avatar-image" : undefined}
        loading="lazy"
        onError={
          variant === "avatar"
            ? (event) => {
                event.currentTarget.hidden = true;
              }
            : undefined
        }
        referrerPolicy="no-referrer"
        src={src}
        title={title}
      />
    );
    if (variant === "avatar") return image;
    return (
      <>
        <button
          aria-label={`Open image viewer${alt ? `: ${alt}` : ""}`}
          className="message-media-trigger"
          onClick={() => setViewerOpen(true)}
          type="button"
        >
          {image}
        </button>
        {viewerOpen ? (
          <ImageLightbox
            alt={alt}
            close={() => setViewerOpen(false)}
            src={src}
            title={title}
          />
        ) : null}
      </>
    );
  }
  if (variant === "avatar" && (failed || !objectUrl)) return null;
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
  const image = (
    // biome-ignore lint/performance/noImgElement: authenticated object URLs cannot use next/image
    <img
      alt={alt}
      className={variant === "avatar" ? "avatar-image" : "message-media-image"}
      src={objectUrl}
      title={title}
    />
  );
  if (variant === "avatar") return image;
  return (
    <>
      <button
        aria-label={`Open image viewer${alt ? `: ${alt}` : ""}`}
        className="message-media-trigger"
        onClick={() => setViewerOpen(true)}
        type="button"
      >
        {image}
      </button>
      {viewerOpen ? (
        <ImageLightbox
          alt={alt}
          close={() => setViewerOpen(false)}
          src={objectUrl}
          title={title}
        />
      ) : null}
    </>
  );
}
