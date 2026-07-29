import type { RequestHandler, Response } from "express";
import { asyncHandler } from "../controllers/asyncHandler";
import type { ResolvedConfig } from "../config";
import { sha256Hex } from "../crypto";
// The Express.Request augmentation that makes `req.mcp` typecheck lives in ../types, not here --
// see the comment there for why it has to be colocated with a re-exported symbol rather than with
// the function that actually populates it at runtime.

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

    // A shop that uninstalls and reinstalls can get a fresh row id under the same domain. A
    // token minted before the reinstall names the *old* row's id in stored.shopId; downstream
    // code (this middleware's own check above included) keys lookups by shopDomain, so without
    // this comparison such a token would authenticate fine against the new installation --
    // stored.shopId is the only thing that still tells the two apart. Stringified: shopId is
    // typed `string | number`, and the stored and freshly-looked-up values may come from
    // different adapters/columns that don't agree on which. (An adapter that reuses the same id
    // across a reinstall -- e.g. an upsert keyed on domain -- will still accept here; that's the
    // adapter's own choice, not a gap in this check.)
    if (String(stored.shopId) !== String(shop.id)) return unauthorized(res, "invalid_token");

    req.mcp = { shopId: stored.shopId, shopDomain: stored.shopDomain, tokenId: stored.id };
    config.storage.touchToken(stored.id, new Date()).catch(() => {});
    next();
  });
}
