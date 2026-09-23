export const THREAD_PANEL_WIDTH_STORAGE_KEY = "buzz.thread-panel-width.v1";

const NARROW_DESKTOP_BREAKPOINT = 1_050;
const WIDE_SIDEBAR_WIDTH = 244;
const NARROW_SIDEBAR_WIDTH = 220;
const WIDE_CHANNEL_MIN_WIDTH = 430;
const NARROW_CHANNEL_MIN_WIDTH = 300;
const WIDE_THREAD_MIN_WIDTH = 340;
const NARROW_THREAD_MIN_WIDTH = 300;
const THREAD_MAX_WIDTH = 720;

export type ThreadPanelWidthBounds = {
  min: number;
  max: number;
};

export function threadPanelWidthBounds(
  viewportWidth: number,
): ThreadPanelWidthBounds {
  const narrow = viewportWidth <= NARROW_DESKTOP_BREAKPOINT;
  const min = narrow ? NARROW_THREAD_MIN_WIDTH : WIDE_THREAD_MIN_WIDTH;
  const available =
    Math.floor(viewportWidth) -
    (narrow ? NARROW_SIDEBAR_WIDTH : WIDE_SIDEBAR_WIDTH) -
    (narrow ? NARROW_CHANNEL_MIN_WIDTH : WIDE_CHANNEL_MIN_WIDTH);

  return {
    min,
    max: Math.max(min, Math.min(THREAD_MAX_WIDTH, available)),
  };
}

export function clampThreadPanelWidth(
  width: number,
  viewportWidth: number,
): number {
  const bounds = threadPanelWidthBounds(viewportWidth);
  if (!Number.isFinite(width)) return bounds.min;
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, width)));
}

export function defaultThreadPanelWidth(viewportWidth: number): number {
  return clampThreadPanelWidth(
    viewportWidth <= NARROW_DESKTOP_BREAKPOINT ? 350 : 410,
    viewportWidth,
  );
}

export function readThreadPanelWidth(
  storage: Pick<Storage, "getItem">,
): number | null {
  try {
    const stored = storage.getItem(THREAD_PANEL_WIDTH_STORAGE_KEY)?.trim();
    if (!stored) return null;
    const width = Number(stored);
    return Number.isFinite(width) && width > 0 ? width : null;
  } catch {
    return null;
  }
}

export function writeThreadPanelWidth(
  storage: Pick<Storage, "setItem">,
  width: number,
): void {
  try {
    storage.setItem(THREAD_PANEL_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {
    // The resize still works when browser storage is blocked or full.
  }
}
