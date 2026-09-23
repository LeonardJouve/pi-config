/** A spawn request waiting for a free concurrency slot. */
export interface QueuedSubagent {
  name: string;
  agent?: string;
  enqueuedAt: number;
  /** Launches the subagent and wires up its watcher. Resolves at launch, not at completion. */
  start: () => Promise<unknown>;
}

export type ScheduleOutcome<T> =
  | { queued: true; position: number }
  | { queued: false; value: T };

export interface SpawnQueue {
  /** Concurrency cap. */
  readonly maxConcurrent: number;
  /** Items still waiting, in FIFO order. */
  pending(): QueuedSubagent[];
  /**
   * Start `item` now if a slot is free, otherwise queue it. Launch errors are
   * rethrown to the caller (same as an unqueued spawn failing).
   */
  schedule<T>(item: {
    name: string;
    agent?: string;
    start: () => Promise<T>;
  }): Promise<ScheduleOutcome<T>>;
  /** Launch queued items while a slot is free. Safe to call concurrently. */
  drain(): Promise<void>;
  /** Drop all waiting items (session shutdown). */
  clear(): void;
}

/**
 * FIFO queue that caps how many subagents run at once.
 *
 * `inFlight` counts launches that have started but are not yet visible in
 * `runningCount()`. Pi runs sibling tool calls concurrently, so without it
 * several `subagent` calls in one assistant message would all see a free slot
 * and blow past the cap.
 *
 * Launches are awaited one at a time so `runningCount()` is current when the
 * cap is re-checked, and the `draining` guard keeps concurrent drain() calls
 * (several subagents finishing at once) from over-launching.
 */
export function createSpawnQueue(deps: {
  maxConcurrent: number;
  runningCount: () => number;
  onStartFailure: (item: QueuedSubagent, error: unknown) => void;
  onChange?: () => void;
}): SpawnQueue {
  const queue: QueuedSubagent[] = [];
  let draining = false;
  let inFlight = 0;

  const hasSlot = () => inFlight + deps.runningCount() < deps.maxConcurrent;

  return {
    maxConcurrent: deps.maxConcurrent,

    pending: () => [...queue],

    async schedule(item) {
      if (!hasSlot()) {
        queue.push({ ...item, enqueuedAt: Date.now() });
        deps.onChange?.();
        return { queued: true, position: queue.length };
      }

      inFlight++;
      try {
        return { queued: false, value: await item.start() };
      } finally {
        inFlight--;
        deps.onChange?.();
      }
    },

    async drain() {
      if (draining) return;
      draining = true;
      try {
        while (queue.length > 0 && hasSlot()) {
          const next = queue.shift()!;
          deps.onChange?.();
          inFlight++;
          try {
            await next.start();
          } catch (error) {
            deps.onStartFailure(next, error);
          } finally {
            inFlight--;
            deps.onChange?.();
          }
        }
      } finally {
        draining = false;
        deps.onChange?.();
      }
    },

    clear() {
      queue.length = 0;
      deps.onChange?.();
    },
  };
}
