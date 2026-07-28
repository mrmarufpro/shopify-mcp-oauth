import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createRateLimiter, type RateLimiterOptions } from "./rateLimit";

// `downstream` stands in for the protected route handler this middleware guards. Every blocked-
// request test passes its own spy and asserts it was never called -- a 429 response that still
// lets the request reach the handler underneath would double-process (or double-charge) whatever
// that handler does, which a status-code-only assertion would never catch.
function buildApp(options: RateLimiterOptions, downstream: () => void = () => {}) {
  const app = express();
  app.post("/register", createRateLimiter(options), (_req, res) => {
    downstream();
    res.status(201).json({ ok: true });
  });
  return app;
}

describe("createRateLimiter", () => {
  it("allows requests up to the limit", async () => {
    const LIMIT = 2;
    const app = buildApp({ limit: LIMIT, windowMs: 60_000 });
    expect((await request(app).post("/register")).status).toBe(201);
    expect((await request(app).post("/register")).status).toBe(201);
  });

  it("answers 429 once the limit is exceeded", async () => {
    const LIMIT = 1;
    const app = buildApp({ limit: LIMIT, windowMs: 60_000 });
    await request(app).post("/register");
    const blocked = await request(app).post("/register");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("too_many_requests");
  });

  it("does not let a blocked request reach the downstream handler", async () => {
    const LIMIT = 1;
    const downstream = vi.fn();
    const app = buildApp({ limit: LIMIT, windowMs: 60_000 }, downstream);
    await request(app).post("/register");
    downstream.mockClear();

    const blocked = await request(app).post("/register");

    expect(blocked.status).toBe(429);
    expect(downstream).not.toHaveBeenCalled();
  });

  it("sets a positive integer Retry-After on a blocked response", async () => {
    const LIMIT = 1;
    const app = buildApp({ limit: LIMIT, windowMs: 60_000 });
    await request(app).post("/register");
    const blocked = await request(app).post("/register");
    const retryAfter = Number(blocked.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it("does not set Retry-After on an allowed response", async () => {
    const LIMIT = 2;
    const app = buildApp({ limit: LIMIT, windowMs: 60_000 });
    const allowed = await request(app).post("/register");
    expect(allowed.headers["retry-after"]).toBeUndefined();
  });

  it("keeps counting past the first request, blocking only once the limit is actually reached", async () => {
    // limit: 1 alone can't tell "the counter increments correctly" apart from "every request past
    // the first is unconditionally blocked" -- both produce the same 201, 429 sequence. A limit of
    // 3 forces `current.count += 1` to run twice before the block, so a mutant that drops (or
    // no-ops) that increment -- leaving count stuck at 1 forever -- shows up here as a 4th request
    // that wrongly stays 201 instead of turning 429.
    const LIMIT = 3;
    const app = buildApp({ limit: LIMIT, windowMs: 60_000 });
    expect((await request(app).post("/register")).status).toBe(201);
    expect((await request(app).post("/register")).status).toBe(201);
    expect((await request(app).post("/register")).status).toBe(201);
    expect((await request(app).post("/register")).status).toBe(429);
  });

  it("stays blocked well before the window has elapsed", async () => {
    // The dangerous direction of the "allows again once the window has passed" test below: a
    // window that resets on every request (or on some timer shorter than windowMs) would still
    // pass that test if its early reset happened to land after the 10ms sleep it uses. Waiting a
    // few ms out of a much longer window, and asserting still-429, catches a reset that fires far
    // too early without depending on precise timing.
    const LIMIT = 1;
    const WINDOW_MS = 300;
    const app = buildApp({ limit: LIMIT, windowMs: WINDOW_MS });
    await request(app).post("/register");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stillBlocked = await request(app).post("/register");
    expect(stillBlocked.status).toBe(429);
  });

  it("allows again once the window has passed", async () => {
    const LIMIT = 1;
    const WINDOW_MS = 1;
    const app = buildApp({ limit: LIMIT, windowMs: WINDOW_MS });
    await request(app).post("/register");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await request(app).post("/register")).status).toBe(201);
  });

  it("counts each key separately", async () => {
    const LIMIT = 1;
    const FIRST_CALLER = "first";
    const SECOND_CALLER = "second";
    const app = express();
    app.post(
      "/register",
      createRateLimiter({ limit: LIMIT, windowMs: 60_000, keyFor: (req) => String(req.headers["x-test-key"]) }),
      (_req, res) => res.status(201).json({ ok: true })
    );

    expect((await request(app).post("/register").set("x-test-key", FIRST_CALLER)).status).toBe(201);
    expect((await request(app).post("/register").set("x-test-key", SECOND_CALLER)).status).toBe(201);
    expect((await request(app).post("/register").set("x-test-key", FIRST_CALLER)).status).toBe(429);
  });

  describe("default key (req.ip)", () => {
    function buildDefaultKeyApp(limit: number, trustProxy: boolean) {
      const app = express();
      if (trustProxy) app.set("trust proxy", true);
      app.post("/register", createRateLimiter({ limit, windowMs: 60_000 }), (_req, res) =>
        res.status(201).json({ ok: true })
      );
      return app;
    }

    it("keys distinct callers separately when trust proxy is configured to match the deployment", async () => {
      const LIMIT = 1;
      const FIRST_CALLER_IP = "203.0.113.10";
      const SECOND_CALLER_IP = "203.0.113.20";
      const app = buildDefaultKeyApp(LIMIT, true);

      expect((await request(app).post("/register").set("X-Forwarded-For", FIRST_CALLER_IP)).status).toBe(201);
      expect((await request(app).post("/register").set("X-Forwarded-For", SECOND_CALLER_IP)).status).toBe(201);
      expect((await request(app).post("/register").set("X-Forwarded-For", FIRST_CALLER_IP)).status).toBe(429);
    });

    it("documents the foot-gun: without trust proxy configured, distinct callers collapse onto one shared bucket", async () => {
      // req.ip ignores X-Forwarded-For entirely when trust proxy is disabled (Express's default),
      // resolving instead to the immediate socket peer -- which, behind any proxy or in this test's
      // supertest server, is the same address for every caller. This is the exact foot-gun
      // documented on defaultKey: a consumer who forgets to configure trust proxy gets one rate
      // limit bucket for their entire user base, not one per caller.
      const LIMIT = 1;
      const app = buildDefaultKeyApp(LIMIT, false);

      expect((await request(app).post("/register").set("X-Forwarded-For", "203.0.113.10")).status).toBe(201);
      const collapsedOntoSameBucket = await request(app).post("/register").set("X-Forwarded-For", "203.0.113.20");
      expect(collapsedOntoSameBucket.status).toBe(429);
    });
  });

  describe("bounded memory", () => {
    it("evicts the oldest tracked key once maxEntries is reached, so memory stays bounded under many distinct keys", async () => {
      const LIMIT = 1;
      const MAX_ENTRIES = 3;
      const EVICTED_CALLER = "evicted-caller";
      const FILLER_CALLERS = ["filler-1", "filler-2", "filler-3"];
      const app = express();
      app.post(
        "/register",
        createRateLimiter({
          limit: LIMIT,
          windowMs: 60_000,
          maxEntries: MAX_ENTRIES,
          keyFor: (req) => String(req.headers["x-test-key"]),
        }),
        (_req, res) => res.status(201).json({ ok: true })
      );

      // Consume EVICTED_CALLER's one allowed request; absent eviction it would stay blocked for
      // the full 60-second window.
      expect((await request(app).post("/register").set("x-test-key", EVICTED_CALLER)).status).toBe(201);
      expect((await request(app).post("/register").set("x-test-key", EVICTED_CALLER)).status).toBe(429);

      // Three more distinct callers push the tracked-key count past MAX_ENTRIES, which must evict
      // EVICTED_CALLER -- the oldest tracked entry -- to keep the map bounded.
      for (const fillerCaller of FILLER_CALLERS) {
        expect((await request(app).post("/register").set("x-test-key", fillerCaller)).status).toBe(201);
      }

      // If eviction were removed, EVICTED_CALLER's original window (limit already spent, far from
      // its 60-second reset) would still be tracked and this would stay 429. With eviction, the
      // entry was dropped, so EVICTED_CALLER is treated as a fresh caller.
      const evictedCallerTreatedAsFresh = await request(app).post("/register").set("x-test-key", EVICTED_CALLER);
      expect(evictedCallerTreatedAsFresh.status).toBe(201);
    });
  });
});
