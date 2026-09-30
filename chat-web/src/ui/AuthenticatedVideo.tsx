"use client";

import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { loadProtectedVideo } from "@/client/video-media";

const RELAY_VIDEO_PATH = /^\/media\/[0-9a-f]{64}(?:\.[a-z0-9]{1,8})?$/;

export function AuthenticatedVideo({
  src,
  label,
  title,
}: {
  src: string;
  label: string;
  title?: string;
}) {
  const [loaded, setLoaded] = useState<{
    source: string;
    url: string;
    attempt: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  let protectedHref: string | null = null;
  try {
    const target = new URL(src);
    if (
      /^https?:$/.test(target.protocol) &&
      RELAY_VIDEO_PATH.test(target.pathname)
    )
      protectedHref = target.href;
  } catch {
    /* Relative public media uses the browser's normal URL resolution. */
  }

  useEffect(() => {
    setError(null);
    setLoaded(null);
    if (!protectedHref) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    void loadProtectedVideo(new URL(protectedHref), controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ source: src, url: objectUrl, attempt });
      })
      .catch((caught) => {
        if (!controller.signal.aborted)
          setError(
            caught instanceof Error
              ? caught.message
              : "Video could not be loaded",
          );
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, protectedHref, attempt]);

  if (error)
    return (
      <span className="message-image-state" role="status">
        {error}
        <button onClick={() => setAttempt((value) => value + 1)} type="button">
          Retry video
        </button>
      </span>
    );
  const videoSrc = protectedHref
    ? loaded?.source === src && loaded.attempt === attempt
      ? loaded.url
      : null
    : src;
  if (!videoSrc)
    return (
      <span className="message-image-state" role="status">
        <LoaderCircle aria-hidden="true" className="spin" size={18} /> Loading
        video…
      </span>
    );
  return (
    // biome-ignore lint/a11y/useMediaCaption: User-provided attachments do not include caption tracks.
    <video
      aria-label={label || "Video attachment"}
      className="message-media-video"
      controls
      onError={() => setError("Video could not be played")}
      playsInline
      preload="metadata"
      src={videoSrc}
      title={title}
    />
  );
}
