import assert from "node:assert/strict";
import test from "node:test";

import {
  focalScrollDelta,
  zoomFromPinch,
  zoomPointDistance,
  zoomPointMidpoint,
} from "./image-zoom";

test("pinch geometry measures distance and midpoint", () => {
  assert.equal(zoomPointDistance({ x: 10, y: 20 }, { x: 40, y: 60 }), 50);
  assert.deepEqual(zoomPointMidpoint({ x: 10, y: 20 }, { x: 40, y: 60 }), {
    x: 25,
    y: 40,
  });
});

test("pinch zoom scales from its starting distance and clamps", () => {
  assert.equal(zoomFromPinch(1, 100, 250, 1, 4), 2.5);
  assert.equal(zoomFromPinch(2, 100, 300, 1, 4), 4);
  assert.equal(zoomFromPinch(2, 100, 20, 1, 4), 1);
  assert.equal(zoomFromPinch(2, 0, 300, 1, 4), 2);
});

test("focal scroll correction holds the requested image point in place", () => {
  assert.deepEqual(
    focalScrollDelta(
      { left: -120, top: -80, width: 800, height: 600 },
      { x: 0.5, y: 0.25 },
      { x: 200, y: 100 },
    ),
    { x: 80, y: -30 },
  );
});
