export interface SummaryQueueOptions {
  readonly concurrency: number;
  readonly maxPending?: number;
  readonly onChange?: () => void;
}

export class SummaryQueue {
  private readonly pending: Array<() => Promise<void>> = [];
  private readonly active = new Set<Promise<void>>();
  private readonly concurrency: number;
  private readonly maxPending: number;
  private readonly onChange?: () => void;
  private closed = false;

  constructor(options: SummaryQueueOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new RangeError("Summary queue concurrency must be at least 1.");
    }
    this.concurrency = options.concurrency;
    this.maxPending = options.maxPending ?? 10;
    this.onChange = options.onChange;
  }

  get activeCount() {
    return this.active.size;
  }

  get pendingCount() {
    return this.pending.length;
  }

  enqueue(task: () => Promise<void>) {
    if (this.closed) return false;
    if (this.pending.length >= this.maxPending) {
      this.pending.shift(); // Drop oldest pending item if queue overflows
    }
    this.pending.push(task);
    this.pump();
    return true;
  }

  close() {
    this.closed = true;
    this.pending.length = 0;
    this.onChange?.();
  }

  reopen() {
    this.closed = false;
  }

  private pump() {
    while (!this.closed && this.active.size < this.concurrency) {
      const task = this.pending.shift();
      if (!task) break;

      let run!: Promise<void>;
      run = Promise.resolve()
        .then(task)
        .catch(() => undefined)
        .finally(() => {
          this.active.delete(run);
          this.onChange?.();
          this.pump();
        });
      this.active.add(run);
      this.onChange?.();
    }
  }

  async waitForActive() {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active]);
    }
  }
}
