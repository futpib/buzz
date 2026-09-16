export type ViewCacheState = "miss" | "fresh" | "stale" | "refreshed";

export type ViewCacheResult<T> = {
  value: T;
  state: ViewCacheState;
  ageMs: number;
};

type Entry<T> = {
  value: T | undefined;
  updatedAt: number;
  lastAccessedAt: number;
  generation: number;
  refresh: Promise<void> | null;
  refreshGeneration: number | null;
};

type ViewCacheOptions = {
  maxEntries: number;
  staleAfterMs: number;
  now?: () => number;
  onBackgroundError?: (error: unknown, key: string) => void;
};

/**
 * A bounded, process-local stale-while-revalidate cache for already projected
 * views. Callers own the key namespace and must include the authenticated
 * session scope in every key.
 */
export class ViewCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly maxEntries: number;
  private readonly staleAfterMs: number;
  private readonly now: () => number;
  private readonly onBackgroundError: (error: unknown, key: string) => void;

  constructor(options: ViewCacheOptions) {
    if (options.maxEntries < 1) {
      throw new Error("View cache maxEntries must be positive");
    }
    if (options.staleAfterMs < 0) {
      throw new Error("View cache staleAfterMs cannot be negative");
    }
    this.maxEntries = options.maxEntries;
    this.staleAfterMs = options.staleAfterMs;
    this.now = options.now ?? Date.now;
    this.onBackgroundError =
      options.onBackgroundError ??
      ((error, key) =>
        console.error(`View cache refresh failed for ${key}`, error));
  }

  async get(key: string, load: () => Promise<T>): Promise<ViewCacheResult<T>> {
    const entry = this.entries.get(key);
    if (entry?.value === undefined) return this.loadMiss(key, load, entry);

    const now = this.now();
    entry.lastAccessedAt = now;
    const ageMs = Math.max(0, now - entry.updatedAt);
    if (ageMs < this.staleAfterMs) {
      return { value: entry.value, state: "fresh", ageMs };
    }

    this.startRefresh(key, entry, load).catch((error) => {
      // The stale value remains a durable retry record. A later read will see
      // it as stale and attempt the refresh again.
      this.onBackgroundError(error, key);
    });
    return { value: entry.value, state: "stale", ageMs };
  }

  async refresh(
    key: string,
    load: () => Promise<T>,
  ): Promise<ViewCacheResult<T>> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = this.makeEntry();
      this.entries.set(key, entry);
      this.evictIfNeeded(key);
    }

    for (;;) {
      const generation = entry.generation;
      await this.startRefresh(key, entry, load);
      const current = this.entries.get(key);
      if (current !== entry) {
        entry = current ?? this.makeEntry();
        if (!current) {
          this.entries.set(key, entry);
          this.evictIfNeeded(key);
        }
        continue;
      }
      if (entry.generation !== generation || entry.value === undefined)
        continue;
      return { value: entry.value, state: "refreshed", ageMs: 0 };
    }
  }

  set(key: string, value: T): void {
    const now = this.now();
    const existing = this.entries.get(key);
    if (existing) {
      existing.generation += 1;
      existing.value = value;
      existing.updatedAt = now;
      existing.lastAccessedAt = now;
    } else {
      this.entries.set(key, {
        value,
        updatedAt: now,
        lastAccessedAt: now,
        generation: 0,
        refresh: null,
        refreshGeneration: null,
      });
      this.evictIfNeeded(key);
    }
  }

  markStale(matches: (key: string) => boolean): void {
    for (const [key, entry] of this.entries) {
      if (!matches(key)) continue;
      entry.generation += 1;
      entry.updatedAt = 0;
    }
  }

  deleteWhere(matches: (key: string) => boolean): void {
    for (const key of this.entries.keys()) {
      if (matches(key)) this.entries.delete(key);
    }
  }

  private async loadMiss(
    key: string,
    load: () => Promise<T>,
    existing?: Entry<T>,
  ): Promise<ViewCacheResult<T>> {
    const entry = existing ?? this.makeEntry();
    if (!existing) {
      this.entries.set(key, entry);
      this.evictIfNeeded(key);
    }
    try {
      await this.startRefresh(key, entry, load);
    } catch (error) {
      if (this.entries.get(key) === entry && entry.value === undefined) {
        this.entries.delete(key);
      }
      throw error;
    }
    const current = this.entries.get(key);
    if (current?.value === undefined) return this.loadMiss(key, load, current);
    return { value: current.value, state: "miss", ageMs: 0 };
  }

  private startRefresh(
    key: string,
    entry: Entry<T>,
    load: () => Promise<T>,
  ): Promise<void> {
    if (entry.refresh) {
      if (entry.refreshGeneration === entry.generation) return entry.refresh;
      const obsolete = entry.refresh;
      return obsolete.then(
        () => this.startRefresh(key, entry, load),
        () => this.startRefresh(key, entry, load),
      );
    }
    const generation = entry.generation;
    const refresh = load()
      .then((value) => {
        if (
          this.entries.get(key) !== entry ||
          entry.generation !== generation
        ) {
          return;
        }
        const now = this.now();
        entry.value = value;
        entry.updatedAt = now;
        entry.lastAccessedAt = now;
      })
      .finally(() => {
        if (entry.refresh === refresh) {
          entry.refresh = null;
          entry.refreshGeneration = null;
        }
        this.evictIfNeeded(key);
      });
    entry.refresh = refresh;
    entry.refreshGeneration = generation;
    return refresh;
  }

  private makeEntry(): Entry<T> {
    return {
      value: undefined,
      updatedAt: 0,
      lastAccessedAt: this.now(),
      generation: 0,
      refresh: null,
      refreshGeneration: null,
    };
  }

  private evictIfNeeded(protectedKey: string): void {
    while (this.entries.size > this.maxEntries) {
      let oldest: [string, Entry<T>] | null = null;
      for (const candidate of this.entries) {
        if (candidate[0] === protectedKey || candidate[1].refresh) continue;
        if (!oldest || candidate[1].lastAccessedAt < oldest[1].lastAccessedAt) {
          oldest = candidate;
        }
      }
      if (!oldest) break;
      this.entries.delete(oldest[0]);
    }
  }
}
