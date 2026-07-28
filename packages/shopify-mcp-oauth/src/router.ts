import { Router } from "express";
import type { ResolvedConfig } from "./config";
import { authorizeController } from "./controllers/authorize";
import { authorizationServerMetadataController, protectedResourceMetadataController } from "./controllers/metadata";
import { openaiAppsChallengeController } from "./controllers/openaiAppsChallenge";
import { registerController } from "./controllers/register";
import { revokeController } from "./controllers/revoke";
import { shopifyCallbackController } from "./controllers/shopifyCallback";
import { tokenController } from "./controllers/token";
import { errorHandler } from "./middlewares/errorHandler";
import { createRateLimiter } from "./middlewares/rateLimit";
import { requireShopifyHmac } from "./middlewares/verifyShopifyHmac";

export interface BuildRouterOptions {
  /** Test-only escape hatch: skips the CIMD private-address guard. Never set this in production. */
  allowPrivateCimdHosts?: boolean;
}

export function buildRouter(config: ResolvedConfig, options: BuildRouterOptions = {}): Router {
  const router = Router();

  const authorizationServer = authorizationServerMetadataController(config);
  const protectedResource = protectedResourceMetadataController(config);

  // Clients probe different discovery URLs; a 404 on the one a given client checks reads to the
  // user as "this server does not support OAuth".
  router.get("/.well-known/oauth-authorization-server", authorizationServer);
  router.get("/.well-known/oauth-authorization-server/mcp", authorizationServer);
  router.get("/.well-known/openid-configuration", authorizationServer);
  router.get("/.well-known/openid-configuration/mcp", authorizationServer);
  router.get("/.well-known/oauth-protected-resource", protectedResource);
  router.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  if (config.openaiAppsChallengeToken) {
    router.get("/.well-known/openai-apps-challenge", openaiAppsChallengeController(config.openaiAppsChallengeToken));
  }

  router.post(
    "/register",
    createRateLimiter({ limit: config.registerRateLimit.limit, windowMs: config.registerRateLimit.windowMs }),
    registerController(config)
  );

  router.get("/authorize", authorizeController(config, { allowPrivateCimdHosts: options.allowPrivateCimdHosts }));
  // The HMAC guard runs first: it must reject a forged callback before shopifyCallbackController
  // ever sees the request, not merely alongside it. See middlewares/verifyShopifyHmac.ts for why
  // this has to check the raw query string (req.originalUrl), never req.query.
  router.get(
    "/oauth/shopify-callback",
    requireShopifyHmac(config.shopify.apiSecret),
    shopifyCallbackController(config)
  );
  router.post("/token", tokenController(config));
  // RFC 7009 requires this to answer 200 regardless of whether the token existed, so it can't be
  // used as a token-guessing oracle -- but it's still free unauthenticated work (two hash +
  // storage lookups per request), the same shape /register's limiter guards against. Its own
  // config field (revokeRateLimit), not registerRateLimit: the two endpoints see very different
  // legitimate call volume and must be tunable independently.
  router.post(
    "/revoke",
    createRateLimiter({ limit: config.revokeRateLimit.limit, windowMs: config.revokeRateLimit.windowMs }),
    revokeController(config)
  );

  // Defense in depth for anything that throws synchronously *inside* this router's own stack --
  // a middleware mounted above (requireShopifyHmac, createRateLimiter) or a future controller that
  // forgets to wrap with asyncHandler. This mount cannot, by itself, catch an error from
  // middleware the consumer mounts before `app.use(oauth.router)` (their own body-parser,
  // typically) -- Express only searches for an error handler within the stack level where the
  // error occurred, and a mounted Router is an ordinary (3-arg) layer to its parent, so the
  // parent's dispatch skips over this entire router when an error is already pending there. See
  // middlewares/errorHandler.ts, and the same `errorHandler` this package also exports on
  // `ShopifyMcpOAuth` for the consumer-mounted half of that fix.
  router.use(errorHandler(config.logger));

  return router;
}
