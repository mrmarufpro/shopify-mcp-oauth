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
  // Snapshotted once, like keyFor/maxEntries above -- not read live off `options` on every
  // request. The ordering argument below depends on windowMs staying constant for this limiter's
  // whole lifetime; reading it live would let a caller who mutates `options.windowMs` after
  // construction break that out from under the eviction logic.
  const windowMs = options.windowMs;
  const limit = options.limit;

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

      // Memory bound (unconditional, holds regardless of which key gets evicted or in what
      // order): every `windows.set` below is preceded by a net entry-count delta of exactly +1
      // (a new key, only when below the cap) or 0 (a new key evicted-then-inserted at the cap, or
      // a refresh deleted-then-reinserted just above) -- so `size <= maxEntries` holds after every
      // call. That's also why this check doesn't need an `isNewKey` guard: whenever this is a
      // refresh, the delete above has already brought size below the cap (size was <= maxEntries
      // beforehand, by this same induction), so the check below is always false for a refresh
      // regardless -- adding `isNewKey &&` here would be an always-false condition, unreachable
      // dead weight in the same shape as the `Math.max` floor removed from Retry-After.
      //
      // Victim selection (conditional on two premises, separate from the bound above): given that
      // (1) windowMs is snapshotted once above rather than re-read from a possibly-mutated
      // `options`, and (2) Date.now() doesn't step backwards, Map iteration order stays ascending
      // by `resetAt` -- a refresh always deletes-then-reinserts (above), so whichever key was last
      // touched longest ago also expires soonest. That's what makes the eviction below remove the
      // most-expired entry first, not just *some* entry.
      //
      // Deliberately no background sweep: it can't lower the bound above (already unconditional),
      // and under the two premises it can't select a different victim than eviction below already
      // does either -- so it would have no observable effect on responses, on which key gets
      // evicted, or on the memory bound. Its only possible contribution -- reclaiming memory
      // slightly earlier than the cap would on its own -- can't be told apart from a silently
      // broken sweep (never runs; or its own throttling gets dropped, degrading into an
      // O(n)-per-request scan) by any test. A once-shipped version had exactly that: it
      // mutation-tested clean everywhere else, but nothing could tell a working sweep from a
      // silently broken one. (If a premise above is ever violated -- e.g. a backward system-clock
      // step -- eviction can pick the wrong victim for a while; that's bounded and self-heals as
      // more requests arrive, and a sweep wouldn't have been immune to the same violation either.)
      if (windows.size >= maxEntries) {
        const oldestKey = windows.keys().next().value;
        if (oldestKey !== undefined) windows.delete(oldestKey);
      }
      windows.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (current.count >= limit) {
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
