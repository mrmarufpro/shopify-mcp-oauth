import type { Application, ErrorRequestHandler, RequestHandler, Router } from "express";
import { createAuthenticator, type Authenticator } from "./authenticate";
import { resolveConfig, type ShopifyMcpOAuthConfig } from "./config";
import { errorHandler } from "./middlewares/errorHandler";
import { requireAuth } from "./middlewares/requireAuth";
import { buildRouter, type BuildRouterOptions } from "./router";

export interface ShopifyMcpOAuth extends Authenticator {
  router: Router;
  /**
   * Mount on any route this server considers protected, after `app.use(oauth.router)`. On success,
   * populates `req.mcp` (see the exported `McpAuthContext` type -- `shopId`, `shopDomain`,
   * `tokenId`) and calls `next()`; on failure, answers 401 with a `WWW-Authenticate` header naming
   * where to start the login flow. `req.mcp` typechecks because this package augments
   * `Express.Request` globally the moment it's imported (see `types.ts`) -- no separate import or
   * setup needed beyond `import "shopify-mcp-oauth"` (or any of its named exports) somewhere in
   * your program.
   */
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
  // One Authenticator, and the returned handle *is* it -- Object.assign mutates and returns its
  // first argument, so `oauth.authenticate` and the function `requireAuth` calls are the same
  // property of the same object. Building a second Authenticator for requireAuth (or spreading this
  // one into a fresh object literal) would leave `oauth.authenticate` a detached copy, and the
  // documented equivalence -- requireAuth *is* authenticate + challenge -- would quietly stop
  // holding for anyone who wraps `oauth.authenticate` to add logging or force a failure in a test.
  const authenticator = createAuthenticator(resolved);
  return Object.assign(authenticator, {
    router: buildRouter(resolved, options),
    requireAuth: requireAuth(resolved, authenticator),
    errorHandler: errorHandler(resolved.logger),
  });
}

/**
 * `createShopifyMcpOAuth` with the mounting done for you, in the one order that works.
 *
 * Three things have to happen in sequence, and getting the third wrong is silent until it matters:
 * the router mounts, then your protected routes, then the error handler LAST -- see
 * `ShopifyMcpOAuth.errorHandler` for why nothing but your app's own final middleware can catch a
 * body-parser error. Register your routes inside `registerProtectedRoutes` and that ordering is
 * structural rather than something to remember:
 *
 * ```ts
 * const app = express();
 * mountShopifyMcpOAuth(app, config, (oauth) => {
 *   app.post("/mcp", oauth.requireAuth, mcpHandler);
 * });
 * ```
 *
 * The one rule this can't enforce: any route you add to `app` AFTER this returns sits below the
 * error handler, so an error it throws escapes to Express's default handler. Add every route from
 * inside the callback, or mount by hand.
 *
 * `registerProtectedRoutes` is required rather than optional for that same reason. Defaulting it to
 * a no-op reads as "routes are optional here" and invites the one call shape this helper exists to
 * rule out -- `const oauth = mountShopifyMcpOAuth(app, config)` followed by `app.post("/mcp", ...)`
 * on the next line, which lands the route below the error handler and restores the exact failure
 * described above. A server with genuinely nothing to protect passes `() => {}` and says so.
 *
 * Body parsing is not mounted for you here -- the router parses its own routes' bodies (see
 * router.ts), and what your MCP endpoint needs is yours to choose. Mount your own parsers on `app`
 * before calling this.
 */
export function mountShopifyMcpOAuth(
  app: Application,
  config: ShopifyMcpOAuthConfig,
  registerProtectedRoutes: (oauth: ShopifyMcpOAuth) => void,
  options: BuildRouterOptions = {}
): ShopifyMcpOAuth {
  const oauth = createShopifyMcpOAuth(config, options);
  app.use(oauth.router);
  registerProtectedRoutes(oauth);
  app.use(oauth.errorHandler);
  return oauth;
}

export { allowAnyShop } from "./adapters/allowAnyShop";
export type { AuthenticatableRequest, Authenticator, AuthFailureReason, AuthResult } from "./authenticate";
export { memoryCache } from "./adapters/memoryCache";
export { memoryStorage, type MemoryStorage } from "./adapters/memoryStorage";
export { prismaStorage, type PrismaLikeClient, type PrismaShopMapping } from "./adapters/prismaStorage";
export { redisCache, type RedisLikeClient, type RedisMultiLike } from "./adapters/redisCache";
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
  ShopNotFoundHandler,
  ShopRef,
  StoredToken,
} from "./types";
