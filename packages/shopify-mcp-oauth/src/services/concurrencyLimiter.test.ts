import { describe, expect, it, vi } from "vitest";
import { createConcurrencyLimiter } from "./concurrencyLimiter";

// A task the test controls the completion of: it records its own name into `started` the moment
// its body actually runs, then hangs until this file explicitly releases it. `started` is a Set,
// not a counter -- once a name is in it, that fact never becomes false again, so a test can
// `vi.waitFor` on it without a race against a counter that's transiently equal to the target value
// for the wrong reason (e.g. still mid-teardown from an earlier task finishing).
function buildControllableTask(
  name: string,
  started: Set<string>
): { task: () => Promise<string>; release: () => void } {
  let releaseFn: (() => void) | undefined;
  const task = async (): Promise<string> => {
    started.add(name);
    await new Promise<void>((resolve) => {
      releaseFn = resolve;
    });
    return "done";
  };
  return {
    task,
    release: () => releaseFn?.(),
  };
}

describe("createConcurrencyLimiter", () => {
  it("runs up to maxConcurrent tasks at once without queueing", async () => {
    const limiter = createConcurrencyLimiter(2);
    const started = new Set<string>();
    const first = buildControllableTask("first", started);
    const second = buildControllableTask("second", started);

    const results = Promise.all([limiter.run(first.task), limiter.run(second.task)]);
    await vi.waitFor(() => expect(started.has("first") && started.has("second")).toBe(true));

    first.release();
    second.release();
    expect(await results).toEqual(["done", "done"]);
  });

  it("queues a task beyond maxConcurrent until a running one finishes", async () => {
    const limiter = createConcurrencyLimiter(2);
    const started = new Set<string>();
    const first = buildControllableTask("first", started);
    const second = buildControllableTask("second", started);
    const third = buildControllableTask("third", started);

    const results = Promise.all([limiter.run(first.task), limiter.run(second.task), limiter.run(third.task)]);
    await vi.waitFor(() => expect(started.has("first") && started.has("second")).toBe(true));
    // The third task's own body must not have started yet -- proven by checking this explicitly,
    // not merely inferred from the pair above having started, which says nothing about a third.
    expect(started.has("third")).toBe(false);

    first.release();
    await vi.waitFor(() => expect(started.has("third")).toBe(true));

    second.release();
    third.release();
    expect(await results).toEqual(["done", "done", "done"]);
  });

  it("serves queued tasks in FIFO order", async () => {
    const limiter = createConcurrencyLimiter(1);
    const order: string[] = [];
    const started = new Set<string>();
    const blocker = buildControllableTask("blocker", started);

    const first = limiter.run(blocker.task);
    const second = limiter.run(async () => {
      order.push("second");
    });
    const third = limiter.run(async () => {
      order.push("third");
    });

    // Release only once the blocker's task body has actually run -- releasing before that (a
    // bug this test's first draft had) calls into a releaseFn that was never assigned yet, so
    // the blocker never actually unblocks and the whole chain hangs.
    await vi.waitFor(() => expect(started.has("blocker")).toBe(true));
    blocker.release();
    await Promise.all([first, second, third]);
    expect(order).toEqual(["second", "third"]);
  });

  it("lets a later task run once an earlier one rejects, rather than leaking its slot", async () => {
    const limiter = createConcurrencyLimiter(1);
    const failing = limiter.run(async () => {
      throw new Error("task failed");
    });
    const following = limiter.run(async () => "ok");

    await expect(failing).rejects.toThrow("task failed");
    expect(await following).toBe("ok");
  });

  it.each([0, -1, 1.5, NaN, Infinity])("rejects a non-positive-integer maxConcurrent (%s)", (invalid) => {
    expect(() => createConcurrencyLimiter(invalid)).toThrow(/positive integer/);
  });
});
