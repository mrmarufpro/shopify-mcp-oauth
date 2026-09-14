import express from "express";
import type { Store } from "express-rate-limit";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../types";
import { createRateLimiter, MAX_RATE_LIMIT_WINDOW_MS } from "./rateLimit";

// Scope: createRateLimiter is a thin wrapper, so this file tests the wrapper, not express-rate-limit.
// Counting, window rotation, store dispatch and IPv6 masking are the library's own, covered by the
// library's own suite -- re-asserting them here buys nothing and breaks on their internals. What is
// ours, and what everything below pins, is the handful of decisions the wrapper makes:
// the input validation the library does not perform, the 429 body shape, the header drafts, whether
// keyGenerator/store are overridden at all, the logger adapter, and the one library behaviour we
// deliberately suppress a warning about (limit: 0).
const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function buildApp(options: Parameters<typeof createRateLimiter>[0]) {
  const app = express();
  app.post("/register", createRateLimiter(options), (_req, res) => res.status(201).json({ ok: true }));
  return app;
}

describe("createRateLimiter", () => {
  it("passes a request under the limit through and answers this package's error body over it", async () => {
    // The 429 body is the wrapper's (RATE_LIMITED_BODY), not express-rate-limit's plain-text
    // default: a client that parses one endpoint's errors should not have to special-case this one.
    // The 201 half is the smoke test that the middleware is wired as a limiter and not, say, as a
    // block-everything mount.
    const app = buildApp({ limit: 1, windowMs: 60_000 });

    expect((await request(app).post("/register")).status).toBe(201);

    const blocked = await request(app).post("/register");
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: "too_many_requests", error_description: "rate limit exceeded" });
  });

  it("emits the standardized draft-7 headers and not the deprecated X-RateLimit-* family", async () => {
    // Pins the `legacyHeaders: false` / `standardHeaders: "draft-7"` pair. Not cosmetic: Retry-After
    // is only emitted when at least one header family is enabled, so turning both off -- a plausible
    // "we don't need headers" edit -- would silently drop the one header a blocked client acts on.
    const WINDOW_MS = 60_000;
    const app = buildApp({ limit: 1, windowMs: WINDOW_MS });

    const allowed = await request(app).post("/register");
    expect(allowed.headers["ratelimit"]).toBe("limit=1, remaining=0, reset=60");
    expect(allowed.headers["ratelimit-policy"]).toBe("1;w=60");
    expect(allowed.headers["x-ratelimit-limit"]).toBeUndefined();

    const blocked = await request(app).post("/register");
    expect(blocked.headers["retry-after"]).toBe(String(WINDOW_MS / 1000));
  });

  it("threads a supplied keyFor through as the key generator", async () => {
    // Without the pass-through every caller shares one IP-keyed bucket while the config claims
    // otherwise. Two distinct keys from the same socket is what makes a missing thread visible.
    const FIRST_CALLER = "first";
    const SECOND_CALLER = "second";
    const app = buildApp({
      limit: 1,
      windowMs: 60_000,
      keyFor: (req) => String(req.headers["x-test-key"]),
    });

    expect((await request(app).post("/register").set("x-test-key", FIRST_CALLER)).status).toBe(201);
    expect((await request(app).post("/register").set("x-test-key", SECOND_CALLER)).status).toBe(201);
    expect((await request(app).post("/register").set("x-test-key", FIRST_CALLER)).status).toBe(429);
  });

  it("leaves express-rate-limit's own key generator in place when no keyFor is supplied", async () => {
    // The wrapper only sets `keyGenerator` when the caller actually supplied one, and that
    // conditional is load-bearing: supplying our own default would replace the library's, and with
    // it the IPv6 subnet masking and the `trust proxy` diagnostics that default performs. IPv6 is
    // the observable half -- an ISP hands a client a whole /64 it can source traffic from at will,
    // so a raw-address key would let it walk through addresses for a fresh quota each time. Two
    // addresses in one /56 landing in one bucket proves the library's generator is still the one
    // running; a `keyGenerator: (req) => req.ip` default here would turn this 201.
    const FIRST_ADDRESS_IN_SUBNET = "2001:db8:abcd:0100::1";
    const SECOND_ADDRESS_IN_SUBNET = "2001:db8:abcd:0155::9";
    const app = express();
    app.set("trust proxy", true); // required for req.ip to read X-Forwarded-For at all
    app.post("/register", createRateLimiter({ limit: 1, windowMs: 60_000, logger: silentLogger }), (_req, res) =>
      res.status(201).json({ ok: true })
    );

    expect((await request(app).post("/register").set("X-Forwarded-For", FIRST_ADDRESS_IN_SUBNET)).status).toBe(201);

    const rotatedToAnotherAddressOfTheSameSubnet = await request(app)
      .post("/register")
      .set("X-Forwarded-For", SECOND_ADDRESS_IN_SUBNET);
    expect(rotatedToAnotherAddressOfTheSameSubnet.status).toBe(429);
  });

  it("counts through a supplied store rather than the library's process memory", async () => {
    // Reports every caller as far over any limit. Nothing the in-process default store does can
    // produce this on a first request, so a 429 here can only mean the supplied store was the one
    // consulted -- which is what makes a shared (e.g. Redis-backed) limit possible at all.
    const alwaysOverLimitStore: Store = {
      async increment() {
        return { totalHits: 999, resetTime: new Date(Date.now() + 60_000) };
      },
      async decrement() {},
      async resetKey() {},
    };
    const app = buildApp({ limit: 5, windowMs: 60_000, store: alwaysOverLimitStore });

    const blockedOnTheVeryFirstRequest = await request(app).post("/register");

    expect(blockedOnTheVeryFirstRequest.status).toBe(429);
  });

  it("blocks every request at limit: 0, the assumption behind suppressing WRN_ERL_MAX_ZERO", async () => {
    // The wrapper turns off express-rate-limit's limit validation, which exists to flag callers who
    // wrote `limit: 0` expecting v6's "disable the limiter" meaning. That suppression is only safe
    // while 0 keeps its v7+ meaning -- block everything. If a future version reverted, the warning
    // we silenced would be exactly the one worth hearing, so the assumption is pinned rather than
    // trusted.
    const app = buildApp({ limit: 0, windowMs: 60_000 });
    expect((await request(app).post("/register")).status).toBe(429);
  });

  it("reports express-rate-limit's own misconfiguration findings through the configured logger", async () => {
    // `trust proxy: true` trusts an X-Forwarded-For header from anyone, so any caller can hand
    // themselves a fresh key per request. express-rate-limit detects that; this asserts the finding
    // reaches the consumer's logger rather than bypassing it to the console.
    const errorLog = vi.fn();
    const app = express();
    app.set("trust proxy", true);
    app.post(
      "/register",
      createRateLimiter({ limit: 1, windowMs: 60_000, logger: { info: () => {}, warn: () => {}, error: errorLog } }),
      (_req, res) => res.status(201).json({ ok: true })
    );

    await request(app).post("/register").set("X-Forwarded-For", "203.0.113.10");

    expect(errorLog).toHaveBeenCalled();
    // This package's Logger takes (msg, meta); express-rate-limit's takes (error, message). The
    // adapter has to swap them, and a straight pass-through would put an Error object where the
    // message goes -- which every logger that formats its first argument as a string would then
    // render as "[object Object]".
    const [message, meta] = errorLog.mock.calls[0] ?? [];
    expect(typeof message).toBe("string");
    expect(message).not.toHaveLength(0);
    expect(meta).toBeInstanceOf(Error);
  });

  describe("input validation", () => {
    // Entirely the wrapper's: express-rate-limit performs none of these, and the one overlapping
    // check it does have (the setInterval ceiling) it only logs. This factory is on the package's
    // public surface, where a consumer calling it directly has none of resolveConfig's zod schema in
    // front of them -- these guards are what stands between a typo'd option and silent misbehaviour.
    it("throws when windowMs is zero", () => {
      expect(() => createRateLimiter({ limit: 1, windowMs: 0 })).toThrow(/windowMs/);
    });

    it("throws when windowMs is negative", () => {
      expect(() => createRateLimiter({ limit: 1, windowMs: -1 })).toThrow(/windowMs/);
    });

    it("throws when windowMs is NaN", () => {
      expect(() => createRateLimiter({ limit: 1, windowMs: NaN })).toThrow(/windowMs/);
    });

    it("throws when windowMs is Infinity, which would otherwise put a non-finite Retry-After on every blocked response", () => {
      expect(() => createRateLimiter({ limit: 1, windowMs: Infinity })).toThrow(/windowMs/);
    });

    it("throws when limit is negative", () => {
      expect(() => createRateLimiter({ limit: -1, windowMs: 60_000 })).toThrow(/limit/);
    });

    it("throws when limit is not an integer", () => {
      expect(() => createRateLimiter({ limit: 1.5, windowMs: 60_000 })).toThrow(/limit/);
    });

    it("throws when limit is NaN", () => {
      expect(() => createRateLimiter({ limit: NaN, windowMs: 60_000 })).toThrow(/limit/);
    });

    it("throws when windowMs exceeds what setInterval can represent, which would silently stop limiting", () => {
      // Node clamps a setInterval delay past this to 1ms instead of erroring, so the store's window
      // rotation would fire every millisecond and forget every caller -- a limiter that answers 200
      // to everything while looking correctly configured. express-rate-limit notices but only logs,
      // leaving the limiter mounted, which is why this has to throw here.
      expect(() => createRateLimiter({ limit: 1, windowMs: MAX_RATE_LIMIT_WINDOW_MS + 1 })).toThrow(/windowMs/);
    });

    it("accepts the largest window setInterval can represent", () => {
      // The bound is the last working value, not the first broken one -- an off-by-one here would
      // reject a window that limits perfectly well.
      expect(() => createRateLimiter({ limit: 1, windowMs: MAX_RATE_LIMIT_WINDOW_MS })).not.toThrow();
    });

    it("accepts limit: 0 as a valid (if unusual) input rather than rejecting it", () => {
      expect(() => createRateLimiter({ limit: 0, windowMs: 60_000 })).not.toThrow();
    });
  });
});
