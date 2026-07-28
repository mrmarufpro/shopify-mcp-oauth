import type { ErrorRequestHandler, RequestHandler, Router } from "express";
import { resolveConfig, type ShopifyMcpOAuthConfig } from "./config";
import { errorHandler } from "./middlewares/errorHandler";
import { requireAuth } from "./middlewares/requireAuth";
import { buildRouter, type BuildRouterOptions } from "./router";

export interface ShopifyMcpOAuth {
  router: Router;
  requireAuth: RequestHandler;
  /**
   * Mount this LAST in your app -- after your own body-parsers and after `router` -- to catch
   * anything that throws before a request ever reaches this package's routes (e.g. malformed JSON
   * in your own `express.json()`). Without it, such an error falls through to Express's own
   * default handler, which answers with an HTML stack trace instead of a safe JSON body. See
   * src/middlewares/errorHandler.ts for why this can't be wired automatically by `router` alone.
   */
  errorHandler: ErrorRequestHandler;
}

export function createShopifyMcpOAuth(
  config: ShopifyMcpOAuthConfig,
  options: BuildRouterOptions = {}
): ShopifyMcpOAuth {
  const resolved = resolveConfig(config);
  return {
    router: buildRouter(resolved, options),
    requireAuth: requireAuth(resolved),
    errorHandler: errorHandler(resolved.logger),
  };
}

export { allowAnyShop } from "./adapters/allowAnyShop";
export { memoryCache } from "./adapters/memoryCache";
export { memoryStorage, type MemoryStorage } from "./adapters/memoryStorage";
export { prismaStorage, type PrismaLikeClient, type PrismaShopMapping } from "./adapters/prismaStorage";
export { redisCache, type RedisLikeClient } from "./adapters/redisCache";
export {
  shopifySessionStorage,
  type ShopifySessionLike,
  type ShopifySessionStorageLike,
} from "./adapters/shopifySessionStorage";
export { resolveConfig, type ResolvedConfig, type ShopifyMcpOAuthConfig } from "./config";
export { OAuthError } from "./errors";
export { createRateLimiter, type RateLimiterOptions } from "./middlewares/rateLimit";
export type { BuildRouterOptions } from "./router";
export type {
  CacheStore,
  Logger,
  McpAuthContext,
  NewOAuthClient,
  NewToken,
  OAuthClient,
  OAuthStorage,
  ShopRef,
  StoredToken,
} from "./types";
