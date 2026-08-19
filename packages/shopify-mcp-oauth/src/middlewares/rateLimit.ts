import type { Request, RequestHandler } from "express";
import { rateLimit, type Store } from "express-rate-limit";
import type { Logger } from "../types";

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  /**
   * Overrides how a caller is identified. Left unset, express-rate-limit's own default is used --
   * `req.ip`, with IPv6 addresses collapsed onto their /56 subnet (see the note on IPv6 below).
   *
   * Pass this function unwrapped rather than closing over it: express-rate-limit inspects a custom
   * key generator's source for a bare `req.ip` reference and warns when it finds one without
   * `ipKeyGenerator` around it, which is exactly the IPv6 foot-gun described below. Wrapping it in
   * an adapter here would hide the reference and silently defeat that check.
   */
  keyFor?: (req: Request) => string;
  /**
   * An express-rate-limit `Store`. Left unset, its in-process `MemoryStore` is used, which is why
   * the limit is per instance: on a multi-instance deployment the effective limit multiplies by
   * the instance count. Supply a shared store (`rate-limit-redis`, for example) to make the limit
   * hold across instances.
   *
   * Use a separate store instance per limiter, or give each a distinct key prefix -- express-rate-limit
   * warns when one store object is handed to more than one limiter, because the two endpoints'
   * counts would otherwise land in the same buckets and share a single limit.
   */
  store?: Store;
  /** Where express-rate-limit's own misconfiguration warnings go. Defaults to the console. */
  logger?: Logger;
}

// The body every blocked request gets. Deliberately the same `error` / `error_description` shape
// the rest of this package's failures use (see errors.ts), not express-rate-limit's default plain
// text: a client that parses one endpoint's errors should not have to special-case this one.
const RATE_LIMITED_BODY = { error: "too_many_requests", error_description: "rate limit exceeded" };

// Config-driven limiters (registerRateLimit, revokeRateLimit) already pass through resolveConfig's
// zod schema (z.number().int().positive()), which rules out every case rejected below. A consumer
// calling this exported factory directly has no such schema in front of them, so it can't be
// allowed to silently misbehave: a non-finite or non-positive windowMs (0, negative, NaN, Infinity)
// would make every window already-expired the instant it's created (and Infinity would put that
// same value straight into the `setInterval` express-rate-limit's MemoryStore uses to sweep), and a
// limit that isn't a non-negative integer would either allow unlimited requests (negative) or not
// do what its value claims. express-rate-limit validates none of these itself.
function assertValidRateLimiterOptions(options: RateLimiterOptions): void {
  if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
    throw new Error("createRateLimiter: windowMs must be a positive, finite number of milliseconds");
  }
  if (!Number.isInteger(options.limit) || options.limit < 0) {
    throw new Error("createRateLimiter: limit must be a non-negative integer");
  }
}

// express-rate-limit's logger takes (error, message); this package's Logger takes (msg, meta).
// Adapted rather than passed through so its warnings land in the consumer's configured logger
// instead of bypassing it to the console -- these are diagnostics about the consumer's own
// deployment (an unset or over-permissive `trust proxy`, a store shared between two limiters), so
// they belong wherever the rest of this package's warnings already go.
function asExpressRateLimitLogger(logger: Logger): {
  warn: (error: unknown, message?: string) => void;
  error: (error: unknown, message?: string) => void;
} {
  const forward =
    (write: (msg: string, meta?: unknown) => void) =>
    (error: unknown, message?: string): void => {
      write(message ?? (error instanceof Error ? error.message : String(error)), error);
    };
  return { warn: forward(logger.warn.bind(logger)), error: forward(logger.error.bind(logger)) };
}

/**
 * A fixed-window request limiter, backed by express-rate-limit.
 *
 * Thin on purpose: everything below is either an option express-rate-limit's defaults get wrong
 * for this package (the 429 body shape, the header drafts) or a guard it does not perform at all
 * (input validation above). The counting, the store abstraction, and the IPv6 subnet masking are
 * express-rate-limit's -- the last of which is why this is no longer hand-rolled. A per-IP limiter
 * keyed on a raw IPv6 address is trivially bypassed by rotating through the addresses of an
 * ISP-assigned subnet, which every IPv6 client has to itself; the default key generator collapses
 * them onto a /56 first.
 *
 * Note the `trust proxy` caveat that comes with any IP-keyed limiter: `req.ip` only names the real
 * caller when the app has configured Express's `trust proxy` setting to match its actual
 * deployment (https://expressjs.com/en/guide/behind-proxies.html) -- something this package cannot
 * do on the consumer's behalf, since it only ever receives a sub-router, never the top-level `app`.
 * Left unconfigured behind a load balancer, `req.ip` resolves to the proxy's own address for every
 * request and the limit applies globally instead of per caller. express-rate-limit detects both
 * halves of that mistake (unset, and the equally wrong `trust proxy: true`) and warns through
 * `logger` above.
 */
export function createRateLimiter(options: RateLimiterOptions): RequestHandler {
  assertValidRateLimiterOptions(options);

  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    // Only override the key generator when the caller actually supplied one. Passing an adapter
    // unconditionally would replace express-rate-limit's default -- and with it the IPv6 subnet
    // masking and the `trust proxy` checks that default performs.
    ...(options.keyFor ? { keyGenerator: options.keyFor } : {}),
    ...(options.store ? { store: options.store } : {}),
    ...(options.logger ? { logger: asExpressRateLimitLogger(options.logger) } : {}),
    message: RATE_LIMITED_BODY,
    // `Retry-After` is emitted on a blocked response whenever either header family is on, so this
    // pair keeps it while dropping the deprecated `X-RateLimit-*` headers (legacy) in favour of the
    // standardized `RateLimit` / `RateLimit-Policy` ones. draft-7 rather than draft-8 because its
    // `limit=..., remaining=..., reset=...` form is the one clients in the wild actually parse.
    legacyHeaders: false,
    standardHeaders: "draft-7",
    // WRN_ERL_MAX_ZERO only exists to flag callers who wrote `limit: 0` expecting v6's "disable the
    // limiter" meaning. Here `limit: 0` means what express-rate-limit v7+ made it mean -- block
    // every request -- and disabling a limiter is done by not configuring one at all (see
    // registerRateLimit / revokeRateLimit in config.ts), so the warning would only ever be noise.
    // Every other validation stays on: they diagnose real misconfigurations in the consumer's app.
    validate: { limit: false },
  });
}
