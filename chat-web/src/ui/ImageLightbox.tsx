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
  focalTranslationDelta,
  type ZoomPoint,
  zoomFromPinch,
  zoomPointDistance,
  zoomPointMidpoint,
} from "@/ui/image-zoom";

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.5;
const EDGE_SETTLE_MS = 180;

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
  const settleFrame = useRef<number | null>(null);
  const settleDelayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleAnimationTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const imageOffset = useRef<ZoomPoint>({ x: 0, y: 0 });

  const cancelOffsetAnimation = useCallback(() => {
    if (settleFrame.current !== null) {
      cancelAnimationFrame(settleFrame.current);
      settleFrame.current = null;
    }
    if (settleAnimationTimer.current !== null) {
      clearTimeout(settleAnimationTimer.current);
      settleAnimationTimer.current = null;
    }
    const image = imageRef.current;
    if (image) image.style.transition = "none";
  }, []);

  const cancelOffsetSettle = useCallback(() => {
    cancelOffsetAnimation();
    if (settleDelayTimer.current !== null) {
      clearTimeout(settleDelayTimer.current);
      settleDelayTimer.current = null;
    }
  }, [cancelOffsetAnimation]);

  const adjustFocalPoint = useCallback(() => {
    const pending = pendingFocalPoint.current;
    const viewport = viewportRef.current;
    const image = imageRef.current;
    if (!pending || !viewport || !image) return;
    cancelOffsetAnimation();
    image.style.transform = "";
    imageOffset.current = { x: 0, y: 0 };
    const delta = focalScrollDelta(
      image.getBoundingClientRect(),
      pending.anchor,
      pending.target,
    );
    viewport.scrollLeft += delta.x;
    viewport.scrollTop += delta.y;
    const translation = focalTranslationDelta(
      image.getBoundingClientRect(),
      pending.anchor,
      pending.target,
    );
    if (Math.abs(translation.x) > 0.01 || Math.abs(translation.y) > 0.01) {
      image.style.transform = `translate3d(${translation.x}px, ${translation.y}px, 0)`;
      imageOffset.current = translation;
    }
    pendingFocalPoint.current = null;
    focalFrame.current = null;
  }, [cancelOffsetAnimation]);

  const settleImageOffset = useCallback(
    (delay = 0) => {
      cancelOffsetAnimation();
      if (settleDelayTimer.current !== null) {
        clearTimeout(settleDelayTimer.current);
        settleDelayTimer.current = null;
      }
      const settle = () => {
        settleDelayTimer.current = null;
        settleFrame.current = requestAnimationFrame(() => {
          settleFrame.current = null;
          const viewport = viewportRef.current;
          const image = imageRef.current;
          const offset = imageOffset.current;
          if (
            !viewport ||
            !image ||
            (Math.abs(offset.x) <= 0.01 && Math.abs(offset.y) <= 0.01)
          ) {
            return;
          }

          const visualRect = image.getBoundingClientRect();
          image.style.transition = "none";
          image.style.transform = "";
          viewport.scrollLeft -= offset.x;
          viewport.scrollTop -= offset.y;
          imageOffset.current = { x: 0, y: 0 };

          const settledRect = image.getBoundingClientRect();
          const rebound = {
            x: visualRect.left - settledRect.left,
            y: visualRect.top - settledRect.top,
          };
          if (Math.abs(rebound.x) <= 0.01 && Math.abs(rebound.y) <= 0.01) {
            return;
          }

          image.style.transform = `translate3d(${rebound.x}px, ${rebound.y}px, 0)`;
          image.getBoundingClientRect();
          image.style.transition = `transform ${EDGE_SETTLE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
          image.style.transform = "";
          settleAnimationTimer.current = setTimeout(() => {
            image.style.transition = "none";
            settleAnimationTimer.current = null;
          }, EDGE_SETTLE_MS);
        });
      };
      if (delay > 0) settleDelayTimer.current = setTimeout(settle, delay);
      else settle();
    },
    [cancelOffsetAnimation],
  );

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
    const hadPendingFocalPoint = pendingFocalPoint.current !== null;
    renderedZoomRef.current = zoom;
    adjustFocalPoint();
    if (
      zoom === MIN_ZOOM &&
      !hadPendingFocalPoint &&
      pointers.current.size === 0
    ) {
      imageRef.current?.style.removeProperty("transform");
      imageOffset.current = { x: 0, y: 0 };
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
      cancelOffsetSettle();
    };
  }, [cancelOffsetSettle, close, zoomAroundViewportCenter]);

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
          if (pointers.current.size === 0) settleImageOffset();
        }}
        onPointerDown={(event) => {
          if (event.pointerType === "mouse" && event.button !== 0) return;
          event.preventDefault();
          cancelOffsetSettle();
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
          else if (remaining.length === 0) settleImageOffset();
        }}
        onWheel={(event) => {
          if (!event.ctrlKey) return;
          event.preventDefault();
          setZoomAtPoint(zoomRef.current * Math.exp(-event.deltaY * 0.01), {
            x: event.clientX,
            y: event.clientY,
          });
          settleImageOffset(140);
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
