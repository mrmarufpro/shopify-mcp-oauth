---
"shopify-mcp-oauth": minor
"create-shopify-mcp": patch
---

Rate limiting is now backed by `express-rate-limit`, configured through a single field, and opt-in.

**Breaking** (a minor bump because this package is still pre-1.0):

- `registerRateLimit` and `revokeRateLimit` are replaced by one field, `rateLimit`, which covers both `/register` and `/revoke`. One setting builds one limiter instance mounted on both routes, so `limit` is what a caller may spend across them combined per window — not per endpoint. The two endpoints are no longer tunable independently; a deployment that needs that can set `rateLimit: false` and mount its own middleware.
- Rate limiting no longer defaults to 20 requests per hour. Omit `rateLimit` and both endpoints are uncapped — no limiter middleware is mounted at all. Pass the newly exported `RECOMMENDED_RATE_LIMIT` to keep the previous behaviour. Leaving the field unset logs a warning at construction; setting it to `false` is the same behaviour said out loud and stays quiet.
- `RateLimiterOptions.maxEntries` is gone. It existed only because the counter was hand-rolled, and `express-rate-limit`'s `MemoryStore` has no equivalent entry cap.
- `ResolvedConfig.registerRateLimit` and `.revokeRateLimit` are replaced by `ResolvedConfig.rateLimit`, typed `RateLimitSetting | null`.

Why the swap, given the old limiter worked:

- **IPv6 callers were keyed on the raw address.** An IPv6 client is routinely handed a whole /64 by its ISP and can source traffic from any address in it, so rotating through the subnet bought a fresh quota per address — a bypass, not an edge case. Callers are now keyed by their /56.
- **Counting was unconditionally in-process, with no way for a consumer to change that.** `rateLimit.store` accepts an `express-rate-limit` `Store`, so a Redis-backed store makes one limit hold across every instance instead of multiplying by the instance count. The `Store` type is re-exported as `RateLimitStore`.

Also in this release:

- `rateLimit.keyFor` overrides how a caller is identified, for deployments where `req.ip` is the wrong identity (a tenant header from an API gateway, an authenticated account id) even with Express's `trust proxy` set correctly.
- `/register` and `/revoke` responses now carry the standardized `RateLimit` and `RateLimit-Policy` headers (draft-7). Previously these endpoints sent no rate-limit headers at all except `Retry-After` on a blocked response; the deprecated `X-RateLimit-*` family is not enabled. `Retry-After` is still sent on every blocked response, now derived from the store's reset time.
- `windowMs` above 2147483647 ms (~24.9 days) is rejected at construction. Node clamps a `setInterval` delay past that to 1 ms, which would rotate the counter's window every millisecond and silently stop limiting.
- A `store` that does not implement the `Store` interface is rejected at construction naming the field, rather than surfacing later as an unattributed `TypeError` from `express-rate-limit`.
- `express-rate-limit`'s own misconfiguration findings — an unset or over-permissive Express `trust proxy` setting, most of them — are reported through your configured `logger` rather than straight to the console.

`createRateLimiter`'s name, signature, `429` body shape, and `limit: 0` (block every request) behaviour are unchanged.
