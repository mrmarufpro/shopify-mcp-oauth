import express from "express";
import type { Store } from "express-rate-limit";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../types";
import { createRateLimiter, type RateLimiterOptions } from "./rateLimit";

// express-rate-limit reports misconfigurations it detects in the surrounding app (an unset or
// over-permissive `trust proxy`, most of them) through the logger it was given. Several tests below
// provoke exactly those conditions on purpose, so they hand it somewhere quiet to report them --
// otherwise every run prints warnings about deliberate test setup.
const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

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

  it("snapshots limit at construction, ignoring later mutation of the options object", async () => {
    // express-rate-limit accepts `limit` as either a number or a per-request function, so reading
    // it live off `options` would be a one-character change away. It must not be: a consumer
    // mutating this same object later -- accidentally or otherwise -- would raise the limit and
    // unblock an already-blocked caller mid-window.
    const options: RateLimiterOptions = { limit: 1, windowMs: 60_000 };
    const app = express();
    app.post("/register", createRateLimiter(options), (_req, res) => res.status(201).json({ ok: true }));

    // Spend the one allowed request under the original limit.
    expect((await request(app).post("/register")).status).toBe(201);

    // Raising `limit` live would unblock the next request instead of keeping it at 429.
    options.limit = 1000;

    const stillBlocked = await request(app).post("/register");
    expect(stillBlocked.status).toBe(429);
  });

  it("snapshots windowMs at construction, ignoring later mutation of the options object", async () => {
    // Reading windowMs live off `options` would only matter the next time a *fresh* window gets
    // created (an insert, not a count check against an already-stored one) -- so this needs a
    // window to actually lapse and get refreshed after the mutation, unlike the limit test above.
    const options: RateLimiterOptions = { limit: 1, windowMs: 30 };
    const app = express();
    app.post("/register", createRateLimiter(options), (_req, res) => res.status(201).json({ ok: true }));

    // First window, under the original (short) windowMs.
    await request(app).post("/register");
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Mutate windowMs to something enormous, then let the lapsed window refresh. If windowMs were
    // read live, this refresh would adopt the huge value; if snapshotted, it keeps using the
    // original short one regardless of what `options.windowMs` says now.
    options.windowMs = 100_000;
    await request(app).post("/register");

    // Wait past the ORIGINAL windowMs (30ms) again, comfortably short of the mutated one
    // (100,000ms). If the refresh above had picked up the live 100,000ms value, this request
    // would still be blocked; snapshotting means it's already lapsed again and reads as fresh.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const shouldBeFreshAgain = await request(app).post("/register");
    expect(shouldBeFreshAgain.status).toBe(201);
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
    // ceil(remaining-ms / 1000) is 1 for any remaining time in (0, 1000] -- true regardless of the
    // exact elapsed time, so this doesn't need precise timing. A `floor` in place of `ceil` here
    // would instead read "0" (remaining ~280ms out of the 300ms window).
    expect(stillBlocked.headers["retry-after"]).toBe("1");
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
      app.post("/register", createRateLimiter({ limit, windowMs: 60_000, logger: silentLogger }), (_req, res) =>
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

  describe("input validation", () => {
    // Task 20 exports this factory on the package's public surface, where a consumer calling it
    // directly has none of resolveConfig's zod schema in front of them -- these guards are what
    // stands between a typo'd option and one of the silent-misbehavior cases below.
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

    it("accepts limit: 0 as a valid (if unusual) input rather than rejecting it", () => {
      expect(() => createRateLimiter({ limit: 0, windowMs: 60_000 })).not.toThrow();
    });
  });

  describe("limit: 0 blocks every request", () => {
    it("blocks the very first request in a brand-new window, not just requests after it", async () => {
      // Before this fix, a fresh window's first request skipped the limit check entirely and was
      // always let through -- correct for any limit >= 1, but silently wrong for limit: 0, which
      // this test would otherwise report as 201 instead of the 429 "block everything" its value
      // claims.
      const app = buildApp({ limit: 0, windowMs: 60_000 });
      const response = await request(app).post("/register");
      expect(response.status).toBe(429);
      expect(response.body.error).toBe("too_many_requests");
    });

    it("keeps blocking every subsequent request in the same window too", async () => {
      const app = buildApp({ limit: 0, windowMs: 60_000 });
      await request(app).post("/register");
      const second = await request(app).post("/register");
      expect(second.status).toBe(429);
    });
  });

  describe("IPv6 callers", () => {
    // An IPv6 client is routinely handed a whole /64 (often more) by its ISP, every address of
    // which it can source traffic from at will. Keying on the raw address would let one caller walk
    // through them and start a fresh quota on each, which is a bypass, not an edge case -- so the
    // key is the /56 the addresses share, not the address itself.
    const FIRST_ADDRESS_IN_SUBNET = "2001:db8:abcd:0100::1";
    const SECOND_ADDRESS_IN_SUBNET = "2001:db8:abcd:0155::9";
    const ADDRESS_IN_A_DIFFERENT_SUBNET = "2001:db8:abcd:0200::1";

    function buildIpv6App(limit: number) {
      const app = express();
      // Required for req.ip to read X-Forwarded-For at all; see the trust proxy block above.
      app.set("trust proxy", true);
      app.post("/register", createRateLimiter({ limit, windowMs: 60_000, logger: silentLogger }), (_req, res) =>
        res.status(201).json({ ok: true })
      );
      return app;
    }

    it("counts two addresses from one ISP-assigned subnet against the same limit", async () => {
      const LIMIT = 1;
      const app = buildIpv6App(LIMIT);

      expect((await request(app).post("/register").set("X-Forwarded-For", FIRST_ADDRESS_IN_SUBNET)).status).toBe(201);

      const rotatedToAnotherAddressOfTheSameSubnet = await request(app)
        .post("/register")
        .set("X-Forwarded-For", SECOND_ADDRESS_IN_SUBNET);
      expect(rotatedToAnotherAddressOfTheSameSubnet.status).toBe(429);
    });

    it("still keys genuinely different subnets apart", async () => {
      // The masking above is only correct if it stops at /56. A mask wide enough to merge unrelated
      // subnets would pass the test above while rate-limiting strangers against each other.
      const LIMIT = 1;
      const app = buildIpv6App(LIMIT);

      expect((await request(app).post("/register").set("X-Forwarded-For", FIRST_ADDRESS_IN_SUBNET)).status).toBe(201);

      const unrelatedCaller = await request(app)
        .post("/register")
        .set("X-Forwarded-For", ADDRESS_IN_A_DIFFERENT_SUBNET);
      expect(unrelatedCaller.status).toBe(201);
    });
  });

  describe("supplied store", () => {
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

    it("counts through the supplied store rather than its own process memory", async () => {
      const GENEROUS_LIMIT = 5;
      const app = buildApp({ limit: GENEROUS_LIMIT, windowMs: 60_000, store: alwaysOverLimitStore });

      const blockedOnTheVeryFirstRequest = await request(app).post("/register");

      expect(blockedOnTheVeryFirstRequest.status).toBe(429);
      expect(blockedOnTheVeryFirstRequest.body.error).toBe("too_many_requests");
    });
  });

  describe("logger", () => {
    it("reports express-rate-limit's own misconfiguration findings through the configured logger", async () => {
      // `trust proxy: true` trusts an X-Forwarded-For header from anyone, so any caller can hand
      // themselves a fresh key per request. express-rate-limit detects that; this asserts the
      // finding reaches the consumer's logger rather than bypassing it to the console.
      const errorLog = vi.fn();
      const app = express();
      app.set("trust proxy", true);
      app.post(
        "/register",
        createRateLimiter({
          limit: 1,
          windowMs: 60_000,
          logger: { info: () => {}, warn: () => {}, error: errorLog },
        }),
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
  });
});
