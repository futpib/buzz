"use client";

import { Minus, Plus, RotateCcw, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import {
  focalScrollDelta,
  type ZoomPoint,
  zoomFromPinch,
  zoomPointDistance,
  zoomPointMidpoint,
} from "@/ui/image-zoom";

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.5;

type PinchState = {
  startDistance: number;
  startZoom: number;
  anchor: ZoomPoint;
};

type PendingFocalPoint = {
  anchor: ZoomPoint;
  target: ZoomPoint;
};

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
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const zoomRef = useRef(zoom);
  const renderedZoomRef = useRef(zoom);
  const pointers = useRef(new Map<number, ZoomPoint>());
  const panPoint = useRef<ZoomPoint | null>(null);
  const pinch = useRef<PinchState | null>(null);
  const pendingFocalPoint = useRef<PendingFocalPoint | null>(null);
  const focalFrame = useRef<number | null>(null);

  const adjustFocalPoint = useCallback(() => {
    const pending = pendingFocalPoint.current;
    const viewport = viewportRef.current;
    const image = imageRef.current;
    if (!pending || !viewport || !image) return;
    const delta = focalScrollDelta(
      image.getBoundingClientRect(),
      pending.anchor,
      pending.target,
    );
    viewport.scrollLeft += delta.x;
    viewport.scrollTop += delta.y;
    pendingFocalPoint.current = null;
    focalFrame.current = null;
  }, []);

  const setZoomAtPoint = useCallback(
    (nextZoom: number, target: ZoomPoint) => {
      const image = imageRef.current;
      if (!image || !fittedSize) return;
      const rect = image.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const boundedZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
      const anchor = {
        x: Math.min(1, Math.max(0, (target.x - rect.left) / rect.width)),
        y: Math.min(1, Math.max(0, (target.y - rect.top) / rect.height)),
      };
      pendingFocalPoint.current = { anchor, target };
      const changed = Math.abs(boundedZoom - zoomRef.current) > 0.001;
      zoomRef.current = boundedZoom;
      setZoom(boundedZoom);
      if (
        !changed &&
        Math.abs(boundedZoom - renderedZoomRef.current) <= 0.001
      ) {
        if (focalFrame.current !== null)
          cancelAnimationFrame(focalFrame.current);
        focalFrame.current = requestAnimationFrame(adjustFocalPoint);
      }
    },
    [adjustFocalPoint, fittedSize],
  );

  const zoomAroundViewportCenter = useCallback(
    (nextZoom: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      setZoomAtPoint(nextZoom, {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
    },
    [setZoomAtPoint],
  );

  const beginPinch = () => {
    const viewport = viewportRef.current;
    const image = imageRef.current;
    const points = [...pointers.current.values()].slice(0, 2);
    if (!viewport || !image || points.length !== 2) return;
    const distance = zoomPointDistance(points[0], points[1]);
    const midpoint = zoomPointMidpoint(points[0], points[1]);
    const rect = image.getBoundingClientRect();
    if (distance <= 0 || rect.width <= 0 || rect.height <= 0) return;
    pinch.current = {
      startDistance: distance,
      startZoom: zoomRef.current,
      anchor: {
        x: Math.min(1, Math.max(0, (midpoint.x - rect.left) / rect.width)),
        y: Math.min(1, Math.max(0, (midpoint.y - rect.top) / rect.height)),
      },
    };
    panPoint.current = null;
  };

  useLayoutEffect(() => {
    renderedZoomRef.current = zoom;
    adjustFocalPoint();
    if (zoom === MIN_ZOOM && !pendingFocalPoint.current) {
      viewportRef.current?.scrollTo({ left: 0, top: 0 });
    }
  }, [adjustFocalPoint, zoom]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key === "+" || event.key === "=") {
        zoomAroundViewportCenter(zoomRef.current + ZOOM_STEP);
      }
      if (event.key === "-") {
        zoomAroundViewportCenter(zoomRef.current - ZOOM_STEP);
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      if (focalFrame.current !== null) cancelAnimationFrame(focalFrame.current);
    };
  }, [close, zoomAroundViewportCenter]);

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
          onClick={() => zoomAroundViewportCenter(zoomRef.current - ZOOM_STEP)}
          type="button"
        >
          <Minus aria-hidden="true" size={19} />
        </button>
        <output aria-label="Image zoom">{Math.round(zoom * 100)}%</output>
        <button
          aria-label="Zoom in"
          disabled={!fittedSize || zoom >= MAX_ZOOM}
          onClick={() => zoomAroundViewportCenter(zoomRef.current + ZOOM_STEP)}
          type="button"
        >
          <Plus aria-hidden="true" size={19} />
        </button>
        <button
          aria-label="Reset zoom"
          disabled={zoom === MIN_ZOOM}
          onClick={() => {
            pendingFocalPoint.current = null;
            zoomRef.current = MIN_ZOOM;
            setZoom(MIN_ZOOM);
          }}
          type="button"
        >
          <RotateCcw aria-hidden="true" size={18} />
        </button>
        <button aria-label="Close image viewer" onClick={close} type="button">
          <X aria-hidden="true" size={21} />
        </button>
      </div>
      <div
        className={`image-lightbox-viewport${zoom > MIN_ZOOM ? " image-lightbox-viewport-zoomed" : ""}`}
        onPointerCancel={(event) => {
          pointers.current.delete(event.pointerId);
          pinch.current = null;
          panPoint.current = null;
        }}
        onPointerDown={(event) => {
          if (event.pointerType === "mouse" && event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          const point = { x: event.clientX, y: event.clientY };
          pointers.current.set(event.pointerId, point);
          if (pointers.current.size >= 2) beginPinch();
          else panPoint.current = point;
        }}
        onPointerMove={(event) => {
          if (!pointers.current.has(event.pointerId)) return;
          event.preventDefault();
          const point = { x: event.clientX, y: event.clientY };
          pointers.current.set(event.pointerId, point);
          if (pointers.current.size >= 2) {
            if (!pinch.current) beginPinch();
            const activePinch = pinch.current;
            const points = [...pointers.current.values()].slice(0, 2);
            if (!activePinch || points.length !== 2) return;
            const midpoint = zoomPointMidpoint(points[0], points[1]);
            const nextZoom = zoomFromPinch(
              activePinch.startZoom,
              activePinch.startDistance,
              zoomPointDistance(points[0], points[1]),
              MIN_ZOOM,
              MAX_ZOOM,
            );
            pendingFocalPoint.current = {
              anchor: activePinch.anchor,
              target: midpoint,
            };
            const changed = Math.abs(nextZoom - zoomRef.current) > 0.001;
            zoomRef.current = nextZoom;
            setZoom(nextZoom);
            if (
              !changed &&
              Math.abs(nextZoom - renderedZoomRef.current) <= 0.001
            ) {
              if (focalFrame.current !== null) {
                cancelAnimationFrame(focalFrame.current);
              }
              focalFrame.current = requestAnimationFrame(adjustFocalPoint);
            }
            return;
          }
          const previous = panPoint.current;
          const viewport = viewportRef.current;
          if (previous && viewport) {
            viewport.scrollLeft -= point.x - previous.x;
            viewport.scrollTop -= point.y - previous.y;
          }
          panPoint.current = point;
        }}
        onPointerUp={(event) => {
          pointers.current.delete(event.pointerId);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          pinch.current = null;
          const remaining = [...pointers.current.values()];
          panPoint.current = remaining.length === 1 ? remaining[0] : null;
          if (remaining.length >= 2) beginPinch();
        }}
        onWheel={(event) => {
          if (!event.ctrlKey) return;
          event.preventDefault();
          setZoomAtPoint(zoomRef.current * Math.exp(-event.deltaY * 0.01), {
            x: event.clientX,
            y: event.clientY,
          });
        }}
        ref={viewportRef}
      >
        {/* biome-ignore lint/performance/noImgElement: viewer may use authenticated object URLs */}
        <img
          alt={alt}
          className={zoom === MIN_ZOOM ? "" : "image-lightbox-zoomed"}
          draggable={false}
          onLoad={(event) => {
            if (fittedSize) return;
            const image = event.currentTarget;
            requestAnimationFrame(() => {
              const { width, height } = image.getBoundingClientRect();
              if (width > 0 && height > 0) setFittedSize({ width, height });
            });
          }}
          src={src}
          ref={imageRef}
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
