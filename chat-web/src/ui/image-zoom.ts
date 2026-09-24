export type ZoomPoint = {
  x: number;
  y: number;
};

/** Returns the distance between two gesture points in CSS pixels. */
export function zoomPointDistance(a: ZoomPoint, b: ZoomPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Returns the midpoint between two gesture points. */
export function zoomPointMidpoint(a: ZoomPoint, b: ZoomPoint): ZoomPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Converts a pinch-distance change into a zoom value bounded by the viewer. */
export function zoomFromPinch(
  startZoom: number,
  startDistance: number,
  currentDistance: number,
  minZoom: number,
  maxZoom: number,
): number {
  if (startDistance <= 0 || !Number.isFinite(currentDistance)) return startZoom;
  return Math.min(
    maxZoom,
    Math.max(minZoom, startZoom * (currentDistance / startDistance)),
  );
}

/**
 * Computes the scroll correction that keeps an image-space focal point under
 * the same client-space gesture point after a zoom layout.
 */
export function focalScrollDelta(
  imageRect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  anchor: ZoomPoint,
  target: ZoomPoint,
): ZoomPoint {
  return {
    x: imageRect.left + imageRect.width * anchor.x - target.x,
    y: imageRect.top + imageRect.height * anchor.y - target.y,
  };
}

/**
 * Computes the visual translation needed when a scroll container cannot apply
 * all of the focal correction because it has reached an edge.
 */
export function focalTranslationDelta(
  imageRect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  anchor: ZoomPoint,
  target: ZoomPoint,
): ZoomPoint {
  const delta = focalScrollDelta(imageRect, anchor, target);
  return { x: -delta.x, y: -delta.y };
}
