export interface ConcurrencyLimiter {
  run<T>(task: () => Promise<T>): Promise<T>;
}

// This module isn't part of the public export surface today, so a caller has no schema in front
// of them the way resolveConfig's zod validation guards config.cimdFetchConcurrency -- guard
// here too, matching createRateLimiter's own defense against the same gap.
function assertValidMaxConcurrent(maxConcurrent: number): void {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new Error("createConcurrencyLimiter: maxConcurrent must be a positive integer");
  }
}

// A minimal counting semaphore: at most maxConcurrent tasks run their work at once; callers
// beyond that queue in arrival order and each runs as soon as an earlier one finishes. No timers,
// no external dependency -- just what's needed to bound how many of something expensive (an
// outbound fetch, here) can be in flight at once, independent of how many callers are waiting.
export function createConcurrencyLimiter(maxConcurrent: number): ConcurrencyLimiter {
  assertValidMaxConcurrent(maxConcurrent);
  let active = 0;
  const queue: Array<() => void> = [];

  function acquire(): Promise<void> {
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => queue.push(resolve));
  }

  function release(): void {
    // A queued waiter inherits the just-freed slot directly, rather than this decrementing
    // `active` and the waiter separately re-incrementing it through acquire() -- that two-step
    // handoff would let `active` observably dip below maxConcurrent for an instant between one
    // task finishing and the next starting, which a caller polling `active` between ticks could
    // catch even though the invariant (never more than maxConcurrent truly concurrent) still held.
    const next = queue.shift();
    if (next) {
      next();
      return;
    }
    active -= 1;
  }

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}
