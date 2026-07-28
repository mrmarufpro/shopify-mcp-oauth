import type { RequestHandler, Response } from "express";
import { asyncHandler } from "../controllers/asyncHandler";
import type { ResolvedConfig } from "../config";
import { sha256Hex } from "../crypto";
import type { McpAuthContext } from "../types";

// Declared against the global Express namespace, not `declare module "express-serve-static-core"`:
// that module is only a transitive dependency of @types/express, not one of this package's own,
// so under pnpm's strict node_modules it doesn't resolve from here and tsc fails with TS2664. The
// module-scoped `Request<...>` type (what RequestHandler's `req` actually is) extends
// `Express.Request`, so augmenting the namespace below reaches it the same way.
declare global {
  namespace Express {
    interface Request {
      mcp?: McpAuthContext;
    }
  }
}

export function requireAuth(config: ResolvedConfig): RequestHandler {
  const resourceMetadata = `${config.host}/.well-known/oauth-protected-resource`;

  // RFC 9728: the header is how a client that has never seen this server discovers where to
  // begin the login flow. Every 401 carries it.
  function unauthorized(res: Response, error: string): void {
    res.setHeader("WWW-Authenticate", `Bearer error="${error}", resource_metadata="${resourceMetadata}"`);
    res.status(401).json({ error });
  }

  // A storage failure here must become a controlled 401/500, not an unhandled rejection --
  // asyncHandler is the seam that already owns that translation for every other handler.
  return asyncHandler(config.logger, async (req, res, next) => {
    const header = req.headers.authorization;
    // RFC 7235 §2.1: the scheme token is case-insensitive ("Bearer", "bearer", "BEARER" all
    // name the same scheme), so this must not reject a client that sent a lowercase scheme.
    const BEARER_PREFIX_LENGTH = "Bearer ".length;
    if (!header || header.slice(0, BEARER_PREFIX_LENGTH).toLowerCase() !== "bearer ") {
      return unauthorized(res, "missing_bearer");
    }

    const token = header.slice(BEARER_PREFIX_LENGTH).trim();
    const stored = await config.storage.findTokenByAccessHash(sha256Hex(token));
    if (!stored) return unauthorized(res, "invalid_token");

    // RFC 8707: this authorization server only ever mints tokens scoped to its own resource
    // today, but the resource server must enforce the audience itself rather than trust that --
    // a storage adapter shared across multiple resource-server deployments must not let one
    // accept a token scoped to another. Strict `!==`, not a null-safe narrowing: a token whose
    // stored resource is null must fail this too, not slip through as "no claim to check".
    if (stored.resource !== config.resource) return unauthorized(res, "invalid_token");

    // A token outlives an uninstall, so confirm the shop is still known on every request.
    const shop = await config.storage.findShopByDomain(stored.shopDomain);
    if (!shop) return unauthorized(res, "invalid_token");

    // Bound to the token's own shopId, not `shop.id` from the lookup above: if a shop uninstalls
    // and reinstalls, the fresh row can get a new id while keeping the same domain. A token
    // minted before the reinstall must not silently gain access to the new installation --
    // binding to stored.shopId fails closed (a downstream lookup keyed on the stale id finds
    // nothing), while binding to the freshly-looked-up shop.id would fail open.
    req.mcp = { shopId: stored.shopId, shopDomain: stored.shopDomain, tokenId: stored.id };
    config.storage.touchToken(stored.id, new Date()).catch(() => {});
    next();
  });
}
