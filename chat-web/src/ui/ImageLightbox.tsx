"use client";

import { Minus, Plus, RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.5;

export function ImageLightbox({
  alt,
  close,
  src,
  title,
}: {
  alt: string;
  close: () => void;
  src: string;
  title?: string;
}) {
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [fittedSize, setFittedSize] = useState<{
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key === "+" || event.key === "=") {
        setZoom((value) => Math.min(MAX_ZOOM, value + ZOOM_STEP));
      }
      if (event.key === "-") {
        setZoom((value) => Math.max(MIN_ZOOM, value - ZOOM_STEP));
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [close]);

  return createPortal(
    <div
      aria-label={alt ? `Image viewer: ${alt}` : "Image viewer"}
      aria-modal="true"
      className="image-lightbox"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      role="dialog"
    >
      <div className="image-lightbox-toolbar">
        <button
          aria-label="Zoom out"
          disabled={!fittedSize || zoom <= MIN_ZOOM}
          onClick={() =>
            setZoom((value) => Math.max(MIN_ZOOM, value - ZOOM_STEP))
          }
          type="button"
        >
          <Minus aria-hidden="true" size={19} />
        </button>
        <output aria-label="Image zoom">{Math.round(zoom * 100)}%</output>
        <button
          aria-label="Zoom in"
          disabled={!fittedSize || zoom >= MAX_ZOOM}
          onClick={() =>
            setZoom((value) => Math.min(MAX_ZOOM, value + ZOOM_STEP))
          }
          type="button"
        >
          <Plus aria-hidden="true" size={19} />
        </button>
        <button
          aria-label="Reset zoom"
          disabled={zoom === MIN_ZOOM}
          onClick={() => setZoom(MIN_ZOOM)}
          type="button"
        >
          <RotateCcw aria-hidden="true" size={18} />
        </button>
        <button aria-label="Close image viewer" onClick={close} type="button">
          <X aria-hidden="true" size={21} />
        </button>
      </div>
      <div className="image-lightbox-viewport">
        {/* biome-ignore lint/performance/noImgElement: viewer may use authenticated object URLs */}
        <img
          alt={alt}
          className={zoom === MIN_ZOOM ? "" : "image-lightbox-zoomed"}
          onLoad={(event) => {
            if (fittedSize) return;
            const image = event.currentTarget;
            requestAnimationFrame(() => {
              const { width, height } = image.getBoundingClientRect();
              if (width > 0 && height > 0) setFittedSize({ width, height });
            });
          }}
          src={src}
          style={
            zoom === MIN_ZOOM || !fittedSize
              ? undefined
              : {
                  width: `${fittedSize.width * zoom}px`,
                  height: `${fittedSize.height * zoom}px`,
                }
          }
          title={title}
        />
      </div>
    </div>,
    document.body,
  );
}
