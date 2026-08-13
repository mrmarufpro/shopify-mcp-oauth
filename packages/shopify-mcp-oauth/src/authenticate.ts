import type { Response } from "express";
import type { ResolvedConfig } from "./config";
import { sha256Hex } from "./crypto";
import type { McpAuthContext } from "./types";

/**
 * Why a bearer token was refused. `missing_bearer` means no usable `Authorization: Bearer` header
 * was present at all; `invalid_token` covers every other refusal (unknown, expired, revoked, minted
 * for another resource server, or naming a shop this server no longer knows). The two are never
 * distinguished further on the wire on purpose — a client learning *which* check failed learns
 * something about tokens it does not hold.
 */
export type AuthFailureReason = "missing_bearer" | "invalid_token";

export type AuthResult = { ok: true; context: McpAuthContext } | { ok: false; reason: AuthFailureReason };

/** Just the part of an Express request this reads, so a caller can pass anything header-shaped. */
export interface AuthenticatableRequest {
  headers: Record<string, string | string[] | undefined>;
}

export interface Authenticator {
  /**
   * Resolves a request's bearer token to a shop identity, without touching the response. Use this
   * when `requireAuth` can't be mounted directly -- typically because the server accepts a second
   * credential scheme of its own and has to decide between them:
   *
   * ```ts
   * app.post("/mcp", async (req, res, next) => {
   *   const mine = await myOwnScheme(req);
   *   if (mine) { req.mcp = mine; return next(); }
   *   const result = await oauth.authenticate(req);
   *   if (!result.ok) return oauth.challenge(res, result.reason);
   *   req.mcp = result.context;
   *   next();
   * });
   * ```
   *
   * A storage failure rejects rather than resolving `{ ok: false }` -- an outage is a 500, not an
   * invitation to log in again. Wrap the call in your own error handling accordingly.
   */
  authenticate(req: AuthenticatableRequest): Promise<AuthResult>;
  /**
   * Writes the RFC 9728 refusal: 401, plus the `WWW-Authenticate` header naming where to start the
   * login flow. That header is how a client that has never seen this server discovers the
   * authorization server at all, so a hand-rolled `res.sendStatus(401)` in its place strands the
   * client -- call this instead, including for a failure of your own scheme.
   */
  challenge(res: Response, reason?: AuthFailureReason): void;
}

export function createAuthenticator(config: ResolvedConfig): Authenticator {
  const resourceMetadata = `${config.host}/.well-known/oauth-protected-resource`;

  return {
    async authenticate(req) {
      const header = req.headers.authorization;
      // RFC 7235 §2.1: the scheme token is case-insensitive ("Bearer", "bearer", "BEARER" all name
      // the same scheme), so this must not reject a client that sent a lowercase scheme.
      const BEARER_PREFIX_LENGTH = "Bearer ".length;
      if (typeof header !== "string" || header.slice(0, BEARER_PREFIX_LENGTH).toLowerCase() !== "bearer ") {
        return { ok: false, reason: "missing_bearer" };
      }

      const token = header.slice(BEARER_PREFIX_LENGTH).trim();
      const stored = await config.storage.findTokenByAccessHash(sha256Hex(token));
      if (!stored) return { ok: false, reason: "invalid_token" };

      // RFC 8707: this authorization server only ever mints tokens scoped to its own resource
      // today, but the resource server must enforce the audience itself rather than trust that --
      // a storage adapter shared across multiple resource-server deployments must not let one
      // accept a token scoped to another. Strict `!==`, not a null-safe narrowing: a token whose
      // stored resource is null must fail this too, not slip through as "no claim to check".
      if (stored.resource !== config.resource) return { ok: false, reason: "invalid_token" };

      // A token outlives an uninstall, so confirm the shop is still known on every request.
      const shop = await config.storage.findShopByDomain(stored.shopDomain);
      if (!shop) return { ok: false, reason: "invalid_token" };

      // A shop that uninstalls and reinstalls can get a fresh row id under the same domain. A
      // token minted before the reinstall names the *old* row's id in stored.shopId; downstream
      // code (the shop lookup above included) keys lookups by shopDomain, so without this
      // comparison such a token would authenticate fine against the new installation --
      // stored.shopId is the only thing that still tells the two apart. Stringified: shopId is
      // typed `string | number`, and the stored and freshly-looked-up values may come from
      // different adapters/columns that don't agree on which. (An adapter that reuses the same id
      // across a reinstall -- e.g. an upsert keyed on domain -- will still accept here; that's the
      // adapter's own choice, not a gap in this check.)
      if (String(stored.shopId) !== String(shop.id)) return { ok: false, reason: "invalid_token" };

      config.storage.touchToken(stored.id, new Date()).catch(() => {});
      return { ok: true, context: { shopId: stored.shopId, shopDomain: stored.shopDomain, tokenId: stored.id } };
    },

    challenge(res, reason = "invalid_token") {
      // `requireAuth` can only reach this before anything has been written, but the composition
      // pattern documented above hands it to host code that ran its own credential scheme first --
      // and that scheme may already have answered, streamed an SSE preamble, or timed out. Calling
      // setHeader after headers are flushed throws ERR_HTTP_HEADERS_SENT from inside the host's own
      // async middleware, where nothing in this package is wrapped around it to catch it: an
      // unhandled rejection or a hung request in place of what was meant to be a 401. There is no
      // useful response left to send at that point, so the only correct action is to not try.
      if (res.headersSent) return;
      res.setHeader("WWW-Authenticate", `Bearer error="${reason}", resource_metadata="${resourceMetadata}"`);
      res.status(401).json({ error: reason });
    },
  };
}
