import assert from "node:assert/strict";
import test from "node:test";

import {
  clampThreadPanelWidth,
  defaultThreadPanelWidth,
  readThreadPanelWidth,
  THREAD_PANEL_WIDTH_STORAGE_KEY,
  threadPanelWidthBounds,
  writeThreadPanelWidth,
} from "./thread-panel-size";

test("thread panel bounds preserve usable channel space across desktop widths", () => {
  assert.deepEqual(threadPanelWidthBounds(1_440), { min: 340, max: 720 });
  assert.deepEqual(threadPanelWidthBounds(1_200), { min: 340, max: 526 });
  assert.deepEqual(threadPanelWidthBounds(1_050), { min: 300, max: 530 });
  assert.deepEqual(threadPanelWidthBounds(821), { min: 300, max: 301 });

  assert.equal(defaultThreadPanelWidth(1_440), 410);
  assert.equal(defaultThreadPanelWidth(1_000), 350);
  assert.equal(defaultThreadPanelWidth(821), 301);
});

test("thread panel width clamps invalid and out-of-range values", () => {
  assert.equal(clampThreadPanelWidth(200, 1_440), 340);
  assert.equal(clampThreadPanelWidth(512.4, 1_440), 512);
  assert.equal(clampThreadPanelWidth(900, 1_440), 720);
  assert.equal(clampThreadPanelWidth(Number.NaN, 1_440), 340);
});

test("thread panel preference tolerates unavailable or malformed storage", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };

  assert.equal(readThreadPanelWidth(storage), null);
  values.set(THREAD_PANEL_WIDTH_STORAGE_KEY, "not-a-width");
  assert.equal(readThreadPanelWidth(storage), null);
  values.set(THREAD_PANEL_WIDTH_STORAGE_KEY, "612.5");
  assert.equal(readThreadPanelWidth(storage), 612.5);

  writeThreadPanelWidth(storage, 477.8);
  assert.equal(values.get(THREAD_PANEL_WIDTH_STORAGE_KEY), "478");

  const blocked = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(readThreadPanelWidth(blocked), null);
  assert.doesNotThrow(() => writeThreadPanelWidth(blocked, 410));
});
