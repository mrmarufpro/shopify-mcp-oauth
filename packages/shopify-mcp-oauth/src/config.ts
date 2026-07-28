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

const configSchema = z.object({
  host: z
    .string()
    .min(1, "host is required")
    .refine((value) => /^https?:\/\//.test(value), "host must be an absolute http(s) URL"),
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
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") ?? "config";
    throw new Error(`shopify-mcp-oauth config invalid at "${path}": ${issue?.message ?? "unknown error"}`);
  }
  if (!input.storage) throw new Error('shopify-mcp-oauth config invalid at "storage": storage is required');

  const host = parsed.data.host.replace(/\/+$/, "");

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
    logger: input.logger ?? console,
    fetchImpl: input.fetchImpl ?? fetch,
  };
}
