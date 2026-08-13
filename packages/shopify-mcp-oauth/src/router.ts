import express, { Router } from "express";
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

// Every POST route below reads req.body, and Express parses none by default. Mounted here rather
// than left to the consumer for two reasons: a consumer has no way to know from the outside that
// /token needs *both* encodings (RFC 6749 §4.1.3 clients post a form; some post JSON), and the
// failure when one is missing is a plausible-looking OAuth error -- "grant_type is required" for a
// request that carried one -- rather than anything that names a missing parser.
//
// Applied per-route, not with router.use(...), so this can never consume the body of a request on
// the consumer's own routes; an MCP transport that wants the raw stream keeps it. Safe to run
// after a consumer's own parser too: body-parser flags a request it has handled and skips it, so
// the second parse is a no-op rather than a re-read of a consumed stream.
const parseJsonBody = express.json();
const parseFormBody = express.urlencoded({ extended: false });

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
    parseJsonBody,
    parseFormBody,
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
  router.post("/token", parseJsonBody, parseFormBody, tokenController(config));
  // RFC 7009 requires this to answer 200 regardless of whether the token existed, so it can't be
  // used as a token-guessing oracle -- but it's still free unauthenticated work (two hash +
  // storage lookups per request), the same shape /register's limiter guards against. Its own
  // config field (revokeRateLimit), not registerRateLimit: the two endpoints see very different
  // legitimate call volume and must be tunable independently.
  router.post(
    "/revoke",
    createRateLimiter({ limit: config.revokeRateLimit.limit, windowMs: config.revokeRateLimit.windowMs }),
    parseJsonBody,
    parseFormBody,
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
