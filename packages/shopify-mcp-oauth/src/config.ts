import { z } from "zod";
import { memoryCache } from "./adapters/memoryCache";
import { createConcurrencyLimiter, type ConcurrencyLimiter } from "./services/concurrencyLimiter";
import type { CacheStore, Logger, OAuthStorage } from "./types";

const DEFAULT_ACCESS_TTL_SECONDS = 3600;
const DEFAULT_REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;
const DEFAULT_REGISTER_RATE_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 };
const DEFAULT_REVOKE_RATE_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 };
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
  tokenTtl?: { access?: number; refresh?: number };
  openaiAppsChallengeToken?: string | null;
  /**
   * Caps requests to the unauthenticated `/register` endpoint. Counted in process memory, not in
   * `cache` above — on a multi-instance deployment the effective limit multiplies by the instance
   * count. That is an acceptable, well-understood shape for a spam brake; see rateLimit.ts for why
   * a cache-backed counter isn't a safe substitute.
   */
  registerRateLimit?: { limit: number; windowMs: number };
  /**
   * Caps requests to the unauthenticated `/revoke` endpoint. Same process-local shape as
   * `registerRateLimit` above (see its own doc comment) — its own field rather than sharing
   * registerRateLimit because the two endpoints see different legitimate call volume and must be
   * tunable independently. RFC 7009 requires `/revoke` to answer 200 whether or not the submitted
   * token existed, so this isn't guarding against it being used as a token-guessing oracle (the
   * response never reveals that either way) — only against unlimited free work (two hash +
   * storage lookups per request) from an unauthenticated caller.
   */
  revokeRateLimit?: { limit: number; windowMs: number };
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
  tokenTtl: { access: number; refresh: number };
  openaiAppsChallengeToken: string | null;
  registerRateLimit: { limit: number; windowMs: number };
  revokeRateLimit: { limit: number; windowMs: number };
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
  "/revoke rate limiters are separate from this cache and always process-local — see registerRateLimit and " +
  "revokeRateLimit.)";

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
  registerRateLimit: z.object({ limit: z.number().int().positive(), windowMs: z.number().int().positive() }).optional(),
  revokeRateLimit: z.object({ limit: z.number().int().positive(), windowMs: z.number().int().positive() }).optional(),
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

  // validateHost already proved this parses; re-derive from the URL (not the raw string) so the
  // scheme and hostname are lowercased and a default port is dropped — token-audience matching
  // against `resource` is plain string equality, so an unnormalized host would fail it silently.
  const parsedHost = new URL(parsed.data.host);
  const host = `${parsedHost.protocol}//${parsedHost.host}${parsedHost.pathname}`.replace(/\/+$/, "");
  const logger = input.logger ?? console;

  if (!input.cache) logger.warn(CACHE_FALLBACK_WARNING);

  const cimdFetchConcurrency = parsed.data.cimdFetchConcurrency ?? DEFAULT_CIMD_FETCH_CONCURRENCY;

  return {
    host,
    resource: `${host}/mcp`,
    shopify: parsed.data.shopify,
    stateSecret: parsed.data.stateSecret,
    storage: input.storage,
    cache: input.cache ?? memoryCache(),
    tokenTtl: {
      access: parsed.data.tokenTtl?.access ?? DEFAULT_ACCESS_TTL_SECONDS,
      refresh: parsed.data.tokenTtl?.refresh ?? DEFAULT_REFRESH_TTL_SECONDS,
    },
    openaiAppsChallengeToken: parsed.data.openaiAppsChallengeToken ?? null,
    registerRateLimit: parsed.data.registerRateLimit ?? DEFAULT_REGISTER_RATE_LIMIT,
    revokeRateLimit: parsed.data.revokeRateLimit ?? DEFAULT_REVOKE_RATE_LIMIT,
    cimdFetchConcurrency,
    cimdFetchLimiter: createConcurrencyLimiter(cimdFetchConcurrency),
    logger,
    fetchImpl: input.fetchImpl ?? fetch,
  };
}
