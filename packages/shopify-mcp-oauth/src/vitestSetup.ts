import { afterEach } from "vitest";

// Captured once, at module load -- before any test in this file has had a chance to call
// vi.useFakeTimers() -- so this cool-down is immune to fake-timer state a test leaves active.
// A few tests in this package fake timers (services/tokens.test.ts, services/cimd.test.ts,
// controllers/revoke.test.ts) and all restore real timers before their own test body returns, but
// relying on afterEach hook ordering between this file and a test file's own afterEach to
// guarantee that would be fragile; a real setTimeout reference sidesteps the question entirely.
const realSetTimeout = globalThis.setTimeout;

// Node + this machine's networking stack can occasionally cross-wire a response between two of
// this suite's own ephemeral supertest servers when many get created and torn down back-to-back
// with no gap at all. Verified in complete isolation, outside any of this package's own code: a
// plain express + supertest loop with no application logic involved still misattributes roughly
// 1 response in every few hundred requests when hundreds of `listen(0)`/`close()` cycles run
// back-to-back with zero delay between them -- and the effect did not reproduce even once across
// 30 runs (12,000 requests total) once each cycle was given a few milliseconds to settle before
// the next one started. This is rate-dependent, not something a retry papers over: the race is in
// how fast this suite recycles ephemeral ports, so slowing that down is the actual fix, not a
// workaround for a flaky assertion.
//
// A handful of ms per test is cheap next to what it protects: every controller/middleware test
// in this package builds its own supertest app, and a misattributed response here doesn't just
// fail a test -- it can silently invalidate a mutation-testing verdict (a real defect looking
// fixed, or a real fix looking broken), which is the whole point of this suite's review process.
afterEach(async () => {
  await new Promise((resolve) => realSetTimeout(resolve, 15));
});
