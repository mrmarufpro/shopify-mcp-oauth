---
"shopify-mcp-oauth": minor
"create-shopify-mcp": patch
---

Rate limiting is now backed by `express-rate-limit`, configured through a single field, and opt-in.

**Breaking** (a minor bump because this package is still pre-1.0):

- `registerRateLimit` and `revokeRateLimit` are replaced by one field, `rateLimit`, covering both `/register` and `/revoke`. One setting builds one limiter mounted on both routes, so `limit` is what a caller spends across them combined per window — not per endpoint. Need them tuned separately? Set `rateLimit: false` and mount your own middleware.
- Rate limiting no longer defaults to 20 requests per hour. Omit `rateLimit` and both endpoints are uncapped, with no limiter middleware mounted at all; pass the newly exported `RECOMMENDED_RATE_LIMIT` to keep the previous behaviour. Omitting warns at construction, `false` is the same behaviour said out loud and stays quiet.
- `ResolvedConfig.registerRateLimit` and `.revokeRateLimit` become `ResolvedConfig.rateLimit`, typed `RateLimitSetting | null`.
- `RateLimiterOptions.maxEntries` is gone; `express-rate-limit`'s `MemoryStore` has no equivalent entry cap.

Why swap a limiter that worked: callers were keyed on the raw IPv6 address, so rotating through the /64 an ISP hands out bought a fresh quota per address — callers are now keyed by /56. And counting was unconditionally in-process; `rateLimit.store` takes an `express-rate-limit` `Store` (re-exported as `RateLimitStore`), so a Redis-backed one holds a single limit across every instance.

Also in this release: `rateLimit.keyFor` overrides caller identity when `req.ip` is the wrong one for your topology; blocked responses carry the standardized `RateLimit` / `RateLimit-Policy` headers (draft-7) alongside `Retry-After`; `windowMs` past 2147483647 ms and a `store` that isn't a `Store` are both rejected at construction naming the field; and `express-rate-limit`'s own findings (an unset or over-permissive `trust proxy`, mostly) go through your configured `logger`.

`createRateLimiter`'s name, signature, `429` body shape, and `limit: 0` (block every request) behaviour are unchanged.
