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
}

const DEFAULT_MAX_ENTRIES = 10_000;

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

  return (req, res, next) => {
    const key = keyFor(req);
    const now = Date.now();

    const stored = windows.get(key);
    const current = stored && stored.resetAt > now ? stored : undefined;

    if (!current) {
      // A lapsed key that's still in the map is being refreshed, not newly added. `Map#set` on a
      // key that already exists updates its value in place *without* moving it in iteration order
      // -- deleting first forces the re-`set` below to re-append it at the tail. Skipping this
      // would let whichever key happened to be seen first squat on the head slot forever: eviction
      // below reads position as a proxy for staleness, so a head-pinned-but-just-refreshed key
      // would become BOTH a wrongful eviction target (it's live, not stale) AND a shield for
      // genuinely stale keys sitting behind it (which never surface to the front to be reclaimed).
      const isNewKey = stored === undefined;
      if (!isNewKey) windows.delete(key);

      // The whole memory story lives here: worst case is bounded at `maxEntries` -- past it, a
      // genuinely new key evicts the single oldest tracked entry, O(1), unlike a reclaim scan, so
      // this stays cheap even while an attacker keeps the map pinned at the cap on every request.
      // Any other expired window is reclaimed lazily, the moment its own key is next seen (above).
      //
      // Deliberately no background sweep beyond that: since a refresh always deletes-then-
      // reinserts (above), Map iteration order is always ascending by `resetAt` (windowMs is
      // constant per limiter, so whichever key was touched longest ago also expires soonest) --
      // meaning eviction here already removes the most-expired entry first, exactly what a sweep
      // would do. A background sweep can't evict a *different* key than this already does, so it
      // has no observable effect on responses, on which key gets evicted, or on the memory bound --
      // its only possible contribution is reclaiming memory slightly earlier than the cap would on
      // its own, against which a broken sweep (never runs; or its own throttling gets dropped,
      // degrading into an O(n)-per-request scan on every single request) is indistinguishable from
      // a correct one to any test. A once-shipped version had exactly that: it mutation-tested
      // clean everywhere else, but no test could tell a working sweep from a silently broken one.
      if (isNewKey && windows.size >= maxEntries) {
        const oldestKey = windows.keys().next().value;
        if (oldestKey !== undefined) windows.delete(oldestKey);
      }
      windows.set(key, { count: 1, resetAt: now + options.windowMs });
      return next();
    }

    if (current.count >= options.limit) {
      // No floor needed: `current` is only ever truthy when `stored.resetAt > now` (see above),
      // using this same `now` -- so resetAt - now is always strictly positive here, and ceiling
      // any positive number of milliseconds to whole seconds always lands on at least 1 (that
      // holds for any positive value, not because milliseconds happen to be integers).
      res.setHeader("Retry-After", Math.ceil((current.resetAt - now) / 1000));
      res.status(429).json({ error: "too_many_requests", error_description: "rate limit exceeded" });
      return;
    }

    current.count += 1;
    next();
  };
}
