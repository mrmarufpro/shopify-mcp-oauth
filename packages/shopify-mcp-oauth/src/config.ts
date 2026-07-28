import { z } from "zod";
import { memoryCache } from "./adapters/memoryCache";
import type { CacheStore, Logger, OAuthStorage } from "./types";

const DEFAULT_ACCESS_TTL_SECONDS = 3600;
const DEFAULT_REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;
const DEFAULT_REGISTER_RATE_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 };

export interface ShopifyMcpOAuthConfig {
  host: string;
  shopify: { apiKey: string; apiSecret: string; scopes: string };
  stateSecret: string;
  storage: OAuthStorage;
  cache?: CacheStore;
  tokenTtl?: { access?: number; refresh?: number };
  openaiAppsChallengeToken?: string | null;
  registerRateLimit?: { limit: number; windowMs: number };
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
  logger: Logger;
  fetchImpl: typeof fetch;
}

const CACHE_FALLBACK_WARNING =
  "shopify-mcp-oauth: no cache supplied, falling back to an in-memory cache. This cache is single-process, so " +
  "authorization codes and rate-limit counters written by one instance are invisible to the others and login " +
  "will fail intermittently across multiple instances — supply a shared cache such as redisCache in production.";

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

  const host = parsed.data.host.replace(/\/+$/, "");
  const logger = input.logger ?? console;

  if (!input.cache) logger.warn(CACHE_FALLBACK_WARNING);

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
    logger,
    fetchImpl: input.fetchImpl ?? fetch,
  };
}
