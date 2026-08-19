---
"shopify-mcp-oauth": minor
"create-shopify-mcp": patch
---

Rate limiting is now backed by `express-rate-limit`, and both limiters are opt-in.

**Breaking** (a minor bump because this package is still pre-1.0):

- `registerRateLimit` and `revokeRateLimit` no longer default to 20 requests per hour. Omit them and `/register` and `/revoke` are uncapped — no limiter middleware is mounted at all. Pass the newly exported `RECOMMENDED_RATE_LIMIT` to either field to keep the previous behaviour. Leaving a field unset logs a warning naming it at construction; setting it to `false` is the same behaviour said out loud and stays quiet.
- `RateLimiterOptions.maxEntries` is gone. It existed only because the counter was hand-rolled, and `express-rate-limit`'s `MemoryStore` has no equivalent entry cap.
- `ResolvedConfig.registerRateLimit` and `.revokeRateLimit` are now `RateLimitSetting | null`.

Why the swap, given the old limiter worked:

- **IPv6 callers were keyed on the raw address.** An IPv6 client is routinely handed a whole /64 by its ISP and can source traffic from any address in it, so rotating through the subnet bought a fresh quota per address — a bypass, not an edge case. Callers are now keyed by their /56.
- **Counting was unconditionally in-process, with no way for a consumer to change that.** `RateLimitSetting.store` accepts an `express-rate-limit` `Store`, so a Redis-backed store makes one limit hold across every instance instead of multiplying by the instance count. The `Store` type is re-exported as `RateLimitStore`.

Also in this release: blocked responses carry standardized `RateLimit` / `RateLimit-Policy` headers (draft-7) in place of the deprecated `X-RateLimit-*` ones, `Retry-After` is unchanged, and `express-rate-limit`'s own misconfiguration findings — an unset or over-permissive Express `trust proxy` setting, most of them — are reported through your configured `logger` rather than straight to the console.

`createRateLimiter`'s name, signature, input validation, `429` body shape, and `limit: 0` (block every request) behaviour are unchanged.
