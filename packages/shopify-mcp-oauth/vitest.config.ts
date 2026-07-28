import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // See src/vitestSetup.ts: a small per-test cool-down for a confirmed, rate-dependent race
    // between this suite's many ephemeral supertest servers -- reproduced in complete isolation
    // (a bare express+supertest loop with no application code) and eliminated there across 30
    // runs / ~12,000 requests. What full-suite A/B testing across 130+ runs and four configs
    // (cool-down alone, file-parallelism disabled alone, both, neither) could NOT do is detect a
    // difference between them at this suite's ~1-3% base failure rate -- that comparison is
    // underpowered for an effect this size, not evidence the cool-down does nothing. Disabling
    // file parallelism was tried and dropped: it measured no additional benefit over the
    // cool-down alone while costing a real ~4.5x wall-time tax (10.9s vs 2.4s), so only the
    // cool-down ships. The provably-complete fix -- one shared server per test file instead of
    // one per test, cutting total listen()/close() cycles from ~200+ to ~29 -- would need to
    // touch every supertest-based file in this package and hasn't been attempted.
    setupFiles: ["./src/vitestSetup.ts"],
  },
});
