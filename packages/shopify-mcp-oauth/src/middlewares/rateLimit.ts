import type { Request, RequestHandler } from "express";

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  keyFor?: (req: Request) => string;
  /**
   * Hard cap on distinct keys tracked at once. Bounds worst-case memory: once the map is full,
   * inserting a never-seen key evicts the single oldest tracked key rather than growing further.
   * Default 10,000.
   */
  maxEntries?: number;
  /**
   * How many requests pass through between amortized sweeps of expired windows. A full scan runs
   * once every N requests instead of on every request, so no single caller pays for the whole
   * map. Default 500.
   */
  sweepIntervalRequests?: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_SWEEP_INTERVAL_REQUESTS = 500;

// req.ip only names the real caller when the app has configured Express's `trust proxy` setting
// to match its actual deployment (see https://expressjs.com/en/guide/behind-proxies.html) --
// something this package cannot do on the consumer's behalf, since it only ever receives a
// sub-router, never the top-level `app`. Left unconfigured behind a load balancer or reverse
// proxy, req.ip resolves to the proxy's own address for every request, so this default key
// collapses all callers onto one shared bucket: the limit then applies globally (one slow
// caller can exhaust it for everyone) instead of per caller. A consumer whose default `req.ip`
// isn't trustworthy or granular enough should configure `trust proxy` correctly and, if that
// still isn't sufficient for their topology, supply their own `keyFor`.
function defaultKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

// Fixed-window counter held in process memory, deliberately not backed by the shared CacheStore:
// CacheStore's contract (get/set/del/getdel) has no atomic increment, so a cache-backed counter
// built from get-then-set would race under concurrent requests for the same key -- two callers
// could both read the same count and both write back the same incremented value, silently
// undercounting and letting more requests through than the configured limit. That failure mode is
// worse than the one being traded away: on a multi-instance deployment the effective limit simply
// multiplies by the instance count, which is an acceptable, well-understood shape for a spam
// brake and is documented as such on `registerRateLimit`.
export function createRateLimiter(options: RateLimiterOptions): RequestHandler {
  const windows = new Map<string, Window>();
  const keyFor = options.keyFor ?? defaultKey;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const sweepIntervalRequests = options.sweepIntervalRequests ?? DEFAULT_SWEEP_INTERVAL_REQUESTS;
  let requestsSinceSweep = 0;

  // Amortized cleanup for keys that are never revisited (an attacker rotating source addresses,
  // or ordinary traffic accumulating over weeks) -- without this, those entries would otherwise
  // sit in the map forever since nothing else ever touches them again. Runs a full O(n) scan once
  // every `sweepIntervalRequests` requests rather than on every request, so the cost is spread
  // thin instead of concentrated on one unlucky caller.
  function sweepExpiredWindows(now: number): void {
    for (const [trackedKey, window] of windows) {
      if (window.resetAt <= now) windows.delete(trackedKey);
    }
  }

  return (req, res, next) => {
    const key = keyFor(req);
    const now = Date.now();

    requestsSinceSweep += 1;
    if (requestsSinceSweep >= sweepIntervalRequests) {
      requestsSinceSweep = 0;
      sweepExpiredWindows(now);
    }

    const stored = windows.get(key);
    const current = stored && stored.resetAt > now ? stored : undefined;

    if (!current) {
      // A never-seen (or lapsed) key is about to add an entry. Cap the worst case here: past
      // maxEntries, drop the single oldest tracked key -- O(1), unlike a reclaim scan, so this
      // stays cheap even while an attacker keeps the map pinned at the cap on every request.
      if (windows.size >= maxEntries) {
        const oldestKey = windows.keys().next().value;
        if (oldestKey !== undefined) windows.delete(oldestKey);
      }
      windows.set(key, { count: 1, resetAt: now + options.windowMs });
      return next();
    }

    if (current.count >= options.limit) {
      // No floor needed: `current` is only ever truthy when `stored.resetAt > now` (see above),
      // using this same `now` -- so resetAt - now is always a positive integer of milliseconds,
      // and ceil-ing anything in (0, 1000] to seconds always lands on at least 1.
      res.setHeader("Retry-After", Math.ceil((current.resetAt - now) / 1000));
      res.status(429).json({ error: "too_many_requests", error_description: "rate limit exceeded" });
      return;
    }

    current.count += 1;
    next();
  };
}
