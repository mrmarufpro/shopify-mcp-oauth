import type { ErrorRequestHandler, RequestHandler, Router } from "express";
import { resolveConfig, type ShopifyMcpOAuthConfig } from "./config";
import { errorHandler } from "./middlewares/errorHandler";
import { requireAuth } from "./middlewares/requireAuth";
import { buildRouter, type BuildRouterOptions } from "./router";

export interface ShopifyMcpOAuth {
  router: Router;
  requireAuth: RequestHandler;
  /**
   * Mount this as the LAST `app.use(...)` call on YOUR OWN top-level Express app -- after your
   * own body-parsers (e.g. `express.json()`) AND after `app.use(router)` -- never inside a
   * router of your own. Express only looks for an error handler within the stack level where an
   * error occurred, and a mounted Router is an ordinary layer to its parent, so an error thrown
   * by a parent-level middleware (your body-parser included) never enters this package's router
   * at all -- nothing mounted anywhere but your app's own final middleware can catch it. Get the
   * placement wrong and such an error falls through to Express's own default handler instead,
   * which answers with an HTML stack trace on an unauthenticated endpoint.
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
