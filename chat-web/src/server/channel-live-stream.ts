import type { ChannelSnapshot, TypingIndicatorView } from "@/server/types";

/** Keep an authoritative projected stream alive across transient relay failures. */
export function channelLiveStream<
  T extends { revision: string } = ChannelSnapshot,
>(input: {
  load: () => Promise<T>;
  listen: (
    dirty: () => void,
    typing: (value: TypingIndicatorView) => void,
    signal: AbortSignal,
  ) => Promise<void>;
  signal: AbortSignal;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  let stop = () => {};
  return new ReadableStream({
    start(controller) {
      let stopped = false;
      let running = false;
      let pending = false;
      let revision = "";
      let refreshDelay = 2_000;
      let listenDelay = 2_000;
      let refreshTimer: ReturnType<typeof setTimeout> | undefined;
      let listenTimer: ReturnType<typeof setTimeout> | undefined;
      const emit = (event: string, data: unknown) => {
        if (!stopped)
          controller.enqueue(
            encoder.encode(
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          );
      };
      const degraded = (error: unknown) =>
        emit("status", {
          state: "degraded",
          message:
            error instanceof Error ? error.message : "Live refresh failed",
        });
      const refresh = async () => {
        if (stopped) return;
        if (running) {
          pending = true;
          return;
        }
        if (refreshTimer) return; // Honor backoff even if more events arrive.
        running = true;
        emit("status", { state: "refreshing" });
        try {
          const snapshot = await input.load();
          if (snapshot.revision !== revision) {
            revision = snapshot.revision;
            emit("snapshot", snapshot);
          }
          refreshDelay = 2_000;
          emit("status", { state: "live" });
        } catch (error) {
          degraded(error);
          if (!stopped) {
            refreshTimer = setTimeout(() => {
              refreshTimer = undefined;
              void refresh();
            }, refreshDelay);
            refreshDelay = Math.min(refreshDelay * 2, 30_000);
          }
        } finally {
          running = false;
          if (pending && !stopped) {
            pending = false;
            void refresh();
          }
        }
      };
      const listen = async () => {
        if (stopped) return;
        emit("status", { state: "connecting" });
        try {
          await input.listen(
            () => {
              listenDelay = 2_000;
              void refresh();
            },
            (value) => emit("typing", value),
            abort.signal,
          );
        } catch (error) {
          degraded(error);
        }
        if (!stopped) {
          listenTimer = setTimeout(() => void listen(), listenDelay);
          listenDelay = Math.min(listenDelay * 2, 30_000);
        }
      };
      const heartbeat = setInterval(() => emit("ping", Date.now()), 15_000);
      stop = () => {
        if (stopped) return;
        stopped = true;
        abort.abort();
        clearTimeout(refreshTimer);
        clearTimeout(listenTimer);
        clearInterval(heartbeat);
        input.signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        stop();
        controller.close();
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
      if (input.signal.aborted) onAbort();
      else void listen();
    },
    cancel() {
      stop();
    },
  });
}
