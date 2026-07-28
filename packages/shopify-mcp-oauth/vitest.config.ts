import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // See src/vitestSetup.ts: a small per-test cool-down that closes a confirmed, rate-dependent
    // race between this suite's many ephemeral supertest servers. Measured (40-run batches):
    // default parallelism + a 4-thread cap still misattributed a response ~1/40 runs; disabling
    // file parallelism entirely, combined with the cool-down, produced 0 failures across 36+
    // consecutive runs before a capped batch ran out of time. Fully serial file execution costs
    // real wall time on a large suite, but every file here already runs in well under a second,
    // so the trade is worth it for a package whose entire value is a trustworthy mutation-tested
    // suite -- see setupFiles' cool-down for why a wrong verdict here is worse than a slow one.
    setupFiles: ["./src/vitestSetup.ts"],
    fileParallelism: false,
  },
});
