type WaitingQuery = {
  start: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Bound relay history bursts and queued work on each authenticated connection. */
export class RelayQueryQueue {
  private active = 0;
  private readonly waiting: WaitingQuery[] = [];
  private closed: Error | null = null;

  run<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed) {
        reject(this.closed);
        return;
      }
      if (this.waiting.length >= 512) {
        reject(new Error("Relay query queue is full; retry shortly"));
        return;
      }
      const start = () => {
        this.active++;
        void Promise.resolve()
          .then(work)
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            const next = this.waiting.shift();
            if (next) {
              clearTimeout(next.timer);
              next.start();
            }
          });
      };
      if (this.active < 2) {
        start();
        return;
      }
      const entry: WaitingQuery = {
        start,
        reject,
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(entry);
          if (index !== -1) this.waiting.splice(index, 1);
          reject(new Error("Relay query queue timed out"));
        }, 30_000),
      };
      this.waiting.push(entry);
    });
  }

  close(error: Error): void {
    this.closed = error;
    for (const entry of this.waiting.splice(0)) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }
}
