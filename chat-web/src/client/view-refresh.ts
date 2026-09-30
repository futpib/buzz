const INTERVAL_MS = 15_000;
const TIMEOUT_MS = 30_000;

/** One request at a time, only while visible; resume and retry without losing rows. */
export function startViewRefresh({
  delay,
  label = "View",
  interval = INTERVAL_MS,
  load,
  onState,
}: {
  delay: number;
  label?: string;
  interval?: number;
  load: (signal: AbortSignal) => Promise<void>;
  onState: (refreshing: boolean, error: string | null) => void;
}) {
  let disposed = false;
  let active: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let error: string | null = null;

  const schedule = (ms: number) => {
    clearTimeout(timer);
    if (!disposed) timer = setTimeout(() => void refresh(), ms);
  };
  async function refresh() {
    if (disposed || active || document.visibilityState === "hidden") return;
    clearTimeout(timer);
    const controller = new AbortController();
    active = controller;
    onState(true, error);
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      await load(controller.signal);
      controller.signal.throwIfAborted();
      failures = 0;
      error = null;
    } catch (cause) {
      if (disposed) return;
      failures += 1;
      error = controller.signal.aborted
        ? `${label} refresh timed out`
        : cause instanceof Error
          ? cause.message
          : `${label} could not refresh`;
    } finally {
      clearTimeout(timeout);
      active = null;
      if (!disposed) {
        onState(false, error);
        schedule(Math.min(60_000, interval * 2 ** Math.min(failures, 2)));
      }
    }
  }
  const resume = () => void refresh();
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("focus", resume);
  window.addEventListener("online", resume);
  schedule(delay);
  return {
    refresh: resume,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      active?.abort();
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
    },
  };
}
