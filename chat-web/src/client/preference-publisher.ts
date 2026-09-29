export function navigationPublishRetryDelay(attempt: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.min(Math.max(0, attempt - 1), 5));
}

type Pending = {
  version: number;
  running: boolean;
  attempt: number;
  error: string | null;
  timer?: ReturnType<typeof setTimeout>;
};

/** One in-flight write per coordinate; only its own revision can acknowledge pending changes. */
export class PreferencePublisher {
  private entries = new Map<string, Pending>();
  private disposed = false;
  constructor(
    private readonly options: {
      initial: string[];
      send: (coordinate: string) => Promise<void>;
      changed: (pending: string[], error: string | null) => void;
    },
  ) {
    for (const coordinate of options.initial)
      this.entries.set(coordinate, this.makePending());
  }

  private makePending(): Pending {
    return { version: 0, running: false, attempt: 0, error: null };
  }

  enqueue(coordinate: string) {
    const entry = this.entries.get(coordinate) ?? this.makePending();
    entry.version++;
    entry.attempt = 0;
    entry.error = null;
    this.entries.set(coordinate, entry);
    this.notify(); // Persist before starting any network operation.
    this.schedule(coordinate, entry, 800);
  }

  retry = () => {
    for (const [coordinate, entry] of this.entries)
      this.schedule(coordinate, entry, 0);
  };

  dispose() {
    this.disposed = true;
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
  }

  private notify() {
    const failed = [...this.entries.values()].find(
      (entry) => entry.attempt >= 3,
    );
    this.options.changed(
      [...this.entries.keys()].sort(),
      failed
        ? `Navigation preferences are waiting to sync: ${failed.error ?? "connection unavailable"}`
        : null,
    );
  }

  private schedule(coordinate: string, entry: Pending, delay: number) {
    if (this.disposed || entry.running) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.publish(coordinate, entry);
    }, delay);
  }

  private async publish(coordinate: string, entry: Pending) {
    if (
      this.disposed ||
      entry.running ||
      this.entries.get(coordinate) !== entry
    )
      return;
    const version = entry.version;
    entry.running = true;
    let retryDelay = 0;
    try {
      await this.options.send(coordinate);
      if (entry.version === version) this.entries.delete(coordinate);
    } catch (error) {
      if (entry.version === version) {
        entry.attempt++;
        entry.error =
          error instanceof Error ? error.message : "connection unavailable";
        retryDelay = navigationPublishRetryDelay(entry.attempt);
      }
    } finally {
      entry.running = false;
      if (!this.disposed) {
        this.notify();
        if (this.entries.get(coordinate) === entry)
          this.schedule(coordinate, entry, retryDelay);
      }
    }
  }
}
