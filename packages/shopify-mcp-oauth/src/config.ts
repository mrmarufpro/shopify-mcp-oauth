import type { Request } from "express";
import type { Store } from "express-rate-limit";
import { z } from "zod";
import { memoryCache } from "./adapters/memoryCache";
import { MAX_RATE_LIMIT_WINDOW_MS } from "./middlewares/rateLimit";
import { createConcurrencyLimiter, type ConcurrencyLimiter } from "./services/concurrencyLimiter";
import type { CacheStore, Logger, OAuthStorage, ShopNotFoundHandler } from "./types";

/** How many requests one caller may make to a rate-limited endpoint per window. */
export interface RateLimitSetting {
  limit: number;
  windowMs: number;
  /**
   * An express-rate-limit `Store`. Left unset, counting happens in this process's memory, so the
   * effective limit multiplies by the instance count on a multi-instance deployment. Supply a
   * shared store (`rate-limit-redis`, for example) to make one limit hold across all of them.
   *
   * Give `registerRateLimit` and `revokeRateLimit` separate store instances (or distinct key
   * prefixes): one store object shared between two limiters puts both endpoints' counts in the
   * same buckets, which express-rate-limit warns about.
   */
  store?: Store;
  /**
   * Overrides how a caller is identified. Left unset, callers are keyed by `req.ip` (with IPv6
   * addresses collapsed onto their /56 subnet), which is right for most deployments but assumes
   * Express's `trust proxy` setting matches yours. Supply this when the caller's identity lives
   * somewhere else -- a tenant header from your API gateway, an authenticated account id -- rather
   * than abandoning these fields and hand-mounting `createRateLimiter`.
   */
  keyFor?: (req: Request) => string;
}

const DEFAULT_ACCESS_TTL_SECONDS = 3600;
const DEFAULT_REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;
// Not applied automatically -- rate limiting is opt-in (see RateLimitSetting). Exported so the
// recommended starting point is a value a consumer can pass rather than a number they have to copy
// out of the README, and so the README and the code cannot drift apart on what "recommended" means.
// Frozen because `resolveConfig` stores whichever object it is given, by reference, into both
// resolved fields -- so a single mutation of a shared constant would silently re-tune every limiter
// built from it afterwards, and `RECOMMENDED_RATE_LIMIT.store = ...` would land one store on both
// endpoints, which is the shared-bucket mistake RateLimitSetting.store warns against. Spread it
// (`{ ...RECOMMENDED_RATE_LIMIT, store }`) to adjust it.
export const RECOMMENDED_RATE_LIMIT: RateLimitSetting = Object.freeze({ limit: 20, windowMs: 60 * 60 * 1000 });
// An unauthenticated caller can drive /authorize with an unlimited number of distinct CIMD
// client_id URLs (see services/cimd.ts), each holding an outbound HTTPS connection open for up to
// TIMEOUT_MS (3s) with no bound on how many run at once — real resource exhaustion on the first
// endpoint any client touches, on every default deployment, not only a misconfigured one. 10 is a
// sane default for a single Node process: generous enough that a legitimate burst of distinct
// CIMD clients queues rather than serializes to uselessness, small enough that a flood of bogus
// URLs can never hold open more than 10 outbound sockets at once regardless of how many requests
// arrive. Deliberately NOT a per-IP limiter (see rateLimit.ts's own req.ip/trust-proxy caveat) —
// this bounds the shared, expensive resource itself, so it can't be defeated by trust-proxy
// bucket-collapse the way an IP-keyed limiter could, and it can't false-positive-lock out a
// legitimate caller the way a request-rate limiter would on the worst possible endpoint for that.
const DEFAULT_CIMD_FETCH_CONCURRENCY = 10;

export interface ShopifyMcpOAuthConfig {
  host: string;
  shopify: { apiKey: string; apiSecret: string; scopes: string };
  stateSecret: string;
  storage: OAuthStorage;
  cache?: CacheStore;
  /**
   * Last-chance shop resolution during the Shopify callback -- see `ShopNotFoundHandler`. Omit it
   * and a shop `findShopByDomain` doesn't know is refused, which is the right default: the hook
   * hands out the access token this package otherwise drops.
   */
  onShopNotFound?: ShopNotFoundHandler;
  tokenTtl?: { access?: number; refresh?: number };
  openaiAppsChallengeToken?: string | null;
  /**
   * Caps requests to the unauthenticated `/register` endpoint. **Off unless you set it.**
   *
   * Omit it (or pass `false`) and `/register` is unlimited: an anonymous caller can create client
   * records in `storage` as fast as they can send requests. Omitting it warns at construction;
   * `false` is the same behaviour said out loud, and stays quiet. `RECOMMENDED_RATE_LIMIT` is a
   * sane starting point.
   *
   * Counted in process memory unless you supply a shared store, so on a multi-instance deployment
   * the effective limit multiplies by the instance count — see `RateLimiterOptions.store` in
   * middlewares/rateLimit.ts.
   */
  registerRateLimit?: RateLimitSetting | false;
  /**
   * Caps requests to the unauthenticated `/revoke` endpoint. **Off unless you set it**, exactly as
   * `registerRateLimit` above (see its own doc comment) — its own field rather than sharing
   * registerRateLimit because the two endpoints see different legitimate call volume and must be
   * tunable independently. RFC 7009 requires `/revoke` to answer 200 whether or not the submitted
   * token existed, so this isn't guarding against it being used as a token-guessing oracle (the
   * response never reveals that either way) — only against unlimited free work (two hash +
   * storage lookups per request) from an unauthenticated caller.
   */
  revokeRateLimit?: RateLimitSetting | false;
  /**
   * Caps how many CIMD client_id documents (see services/cimd.ts) this process fetches over the
   * network at once, across every /authorize request combined — not per caller, and not a
   * request-rate limit. Defaults to 10. Requests beyond the cap queue (FIFO) for a free slot
   * rather than being rejected; each fetch is itself already bounded to a few seconds by this
   * package's own internal timeout, so a queued caller waits at most a few cap-sized batches, not
   * indefinitely.
   */
  cimdFetchConcurrency?: number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

export interface ResolvedConfig {
  host: string;
  resource: string;
  shopify: { apiKey: string; apiSecret: string; scopes: string };
  stateSecret: string;
  storage: OAuthStorage;
  cache: CacheStore;
  onShopNotFound: ShopNotFoundHandler | null;
  tokenTtl: { access: number; refresh: number };
  openaiAppsChallengeToken: string | null;
  /** `null` when no limiter should be mounted on the endpoint at all. */
  registerRateLimit: RateLimitSetting | null;
  /** `null` when no limiter should be mounted on the endpoint at all. */
  revokeRateLimit: RateLimitSetting | null;
  /** The resolved (defaulted or explicit) cap `cimdFetchLimiter` below was actually built from. */
  cimdFetchConcurrency: number;
  cimdFetchLimiter: ConcurrencyLimiter;
  logger: Logger;
  fetchImpl: typeof fetch;
}

const CACHE_FALLBACK_WARNING =
  "shopify-mcp-oauth: no cache supplied, falling back to an in-memory cache. This cache is single-process, so " +
  "authorization codes written by one instance are invisible to the others and login will fail intermittently " +
  "across multiple instances — supply a shared cache such as redisCache in production. (The /register and " +
  "/revoke rate limiters do not use this cache at all — they are opt-in and carry their own store; see " +
  "registerRateLimit and revokeRateLimit.)";

// Rate limiting is opt-in, so the out-of-the-box deployment leaves two unauthenticated endpoints
// uncapped -- /register in particular writes a client record to `storage` on every accepted call.
// That is a deliberate default (a limiter this package mounts unasked is one the consumer cannot
// see in their own code, and its process-local counting surprises multi-instance deployments), but
// it is not one a consumer should discover from an incident. Warned rather than defaulted-on for
// the same reason CACHE_FALLBACK_WARNING exists: name the risk, leave the choice.
//
// Passing `false` silences this while resolving identically. That distinction is the whole point of
// accepting `false` at all -- omitting the field reads as "never thought about it", `false` reads
// as "considered, declined", and only the first is worth a warning on every boot.
const RATE_LIMIT_DISABLED_WARNING_PREFIX = "shopify-mcp-oauth: no rate limit configured for ";
const RATE_LIMIT_DISABLED_WARNING_SUFFIX =
  ". Unauthenticated and uncapped, that can be driven as fast as an anonymous caller can send requests " +
  "(/register writes a client record to storage on each accepted call). Set the field named above to " +
  "RECOMMENDED_RATE_LIMIT to cap it, or to false to accept this deliberately and silence this warning.";

// A prefix regex only checks the string starts with a scheme; new URL() also catches a missing
// hostname, a query string, or a fragment, none of which are valid in the resource identifier
// this host is used to derive.
function validateHost(value: string, ctx: z.RefinementCtx): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "host must be an absolute http(s) URL" });
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "host must use the http or https protocol" });
    return;
  }
  if (!url.hostname) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "host must include a hostname" });
    return;
  }
  if (url.username || url.password) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "host must not include a username or password" });
    return;
  }
  if (url.search) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "host must not include a query string" });
    return;
  }
  if (url.hash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "host must not include a fragment" });
  }
}

const rateLimitSettingSchema = z
  .union([
    z.literal(false),
    z.object({
      limit: z.number().int().positive(),
      // Capped for the same reason createRateLimiter caps it -- see MAX_RATE_LIMIT_WINDOW_MS. The
      // factory would reject this too, but only once buildRouter got that far, with a message
      // naming `createRateLimiter` rather than the config field the consumer actually wrote.
      windowMs: z.number().int().positive().max(MAX_RATE_LIMIT_WINDOW_MS),
    }),
  ])
  .optional();

const configSchema = z.object({
  host: z.string().min(1, "host is required").superRefine(validateHost),
  shopify: z.object({
    apiKey: z.string().min(1, "shopify.apiKey is required"),
    apiSecret: z.string().min(1, "shopify.apiSecret is required"),
    scopes: z.string().min(1, "shopify.scopes is required"),
  }),
  stateSecret: z.string().min(32, "stateSecret must be at least 32 characters"),
  tokenTtl: z
    .object({ access: z.number().int().positive().optional(), refresh: z.number().int().positive().optional() })
    .optional(),
  openaiAppsChallengeToken: z.string().min(1).nullish(),
  registerRateLimit: rateLimitSettingSchema,
  revokeRateLimit: rateLimitSettingSchema,
  cimdFetchConcurrency: z.number().int().positive().optional(),
});

export function resolveConfig(input: ShopifyMcpOAuthConfig): ResolvedConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `"${issue.path.join(".") || "config"}": ${issue.message}`)
      .join("; ");
    throw new Error(`shopify-mcp-oauth config invalid at ${details}`);
  }
  if (!input.storage) throw new Error('shopify-mcp-oauth config invalid at "storage": storage is required');

  // Not expressible in configSchema above (zod would have to own a function type in an otherwise
  // data-shaped schema), but checked here for the same reason redisCache validates its client at
  // construction: left alone, a JavaScript caller who passes the wrong thing — an object, a promise,
  // a misspelled property — boots perfectly cleanly and then fails with
  // `config.onShopNotFound is not a function` inside the Shopify callback, i.e. as a 500 during a
  // real merchant's login, with nothing naming the misconfiguration.
  if (
    input.onShopNotFound !== undefined &&
    input.onShopNotFound !== null &&
    typeof input.onShopNotFound !== "function"
  ) {
    throw new Error(
      'shopify-mcp-oauth config invalid at "onShopNotFound": must be a function returning a ShopRef or null'
    );
  }

  // Not expressible in configSchema either, and for a sharper reason than onShopNotFound above:
  // zod's object schema *strips* `store` rather than rejecting it, so nothing in the schema ever
  // sees it. Left unchecked, a plausible wrong value -- a Redis client instead of the store that
  // wraps it, which is the exact mix-up the README's example invites -- reaches express-rate-limit
  // and throws "An invalid store was passed", naming neither the field nor which of the two
  // limiters it came from.
  for (const field of ["registerRateLimit", "revokeRateLimit"] as const) {
    const setting = input[field];
    if (!setting || setting.store === undefined) continue;
    const store = setting.store as Partial<Store>;
    const implementsStore =
      typeof store.increment === "function" &&
      typeof store.decrement === "function" &&
      typeof store.resetKey === "function";
    if (!implementsStore) {
      throw new Error(
        `shopify-mcp-oauth config invalid at "${field}.store": must implement the express-rate-limit Store interface (increment, decrement, resetKey). A Redis client is not a store -- wrap it, e.g. new RedisStore({ sendCommand }).`
      );
    }
  }

  // validateHost already proved this parses; re-derive from the URL (not the raw string) so the
  // scheme and hostname are lowercased and a default port is dropped — token-audience matching
  // against `resource` is plain string equality, so an unnormalized host would fail it silently.
  const parsedHost = new URL(parsed.data.host);
  const host = `${parsedHost.protocol}//${parsedHost.host}${parsedHost.pathname}`.replace(/\/+$/, "");
  const logger = input.logger ?? console;

  if (!input.cache) logger.warn(CACHE_FALLBACK_WARNING);

  // Only an omitted field warns; `false` is the acknowledged opt-out. Collected into one warning
  // rather than one per field so a consumer who left both unset gets a single line naming both.
  const unlimitedEndpoints: string[] = [];
  if (input.registerRateLimit === undefined) unlimitedEndpoints.push("/register (registerRateLimit)");
  if (input.revokeRateLimit === undefined) unlimitedEndpoints.push("/revoke (revokeRateLimit)");
  if (unlimitedEndpoints.length > 0) {
    logger.warn(
      RATE_LIMIT_DISABLED_WARNING_PREFIX + unlimitedEndpoints.join(" and ") + RATE_LIMIT_DISABLED_WARNING_SUFFIX
    );
  }

  const cimdFetchConcurrency = parsed.data.cimdFetchConcurrency ?? DEFAULT_CIMD_FETCH_CONCURRENCY;

  return {
    host,
    resource: `${host}/mcp`,
    shopify: parsed.data.shopify,
    stateSecret: parsed.data.stateSecret,
    storage: input.storage,
    cache: input.cache ?? memoryCache(),
    onShopNotFound: input.onShopNotFound ?? null,
    tokenTtl: {
      access: parsed.data.tokenTtl?.access ?? DEFAULT_ACCESS_TTL_SECONDS,
      refresh: parsed.data.tokenTtl?.refresh ?? DEFAULT_REFRESH_TTL_SECONDS,
    },
    openaiAppsChallengeToken: parsed.data.openaiAppsChallengeToken ?? null,
    // Read off `input`, not `parsed.data`: zod validated the numbers, but its object schema strips
    // `store` (a class instance the schema deliberately does not model, the same treatment
    // `storage` and `cache` get above).
    registerRateLimit: input.registerRateLimit || null,
    revokeRateLimit: input.revokeRateLimit || null,
    cimdFetchConcurrency,
    cimdFetchLimiter: createConcurrencyLimiter(cimdFetchConcurrency),
    logger,
    fetchImpl: input.fetchImpl ?? fetch,
  };
}
