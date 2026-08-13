export interface ShopRef {
  id: string | number;
  domain: string;
}

export interface OAuthClient {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  grantTypes: string[] | null;
  responseTypes: string[] | null;
  logoUri: string | null;
  clientUri: string | null;
  tokenEndpointAuthMethod: string;
  revokedAt: Date | null;
}
export type NewOAuthClient = Omit<OAuthClient, "revokedAt">;

export interface StoredToken {
  id: string;
  shopId: string | number;
  /** Denormalized so the resource server can name the shop without a reverse lookup by id. */
  shopDomain: string;
  clientId: string;
  accessTokenHash: string;
  refreshTokenHash: string | null;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date | null;
  scope: string | null;
  resource: string | null;
  revokedAt: Date | null;
  rotatedFromId: string | null;
}
export type NewToken = Omit<StoredToken, "id" | "revokedAt">;

export interface OAuthStorage {
  findClient(clientId: string): Promise<OAuthClient | null>;
  createClient(client: NewOAuthClient): Promise<OAuthClient>;
  upsertClient(client: NewOAuthClient): Promise<OAuthClient>;
  createToken(token: NewToken): Promise<StoredToken>;
  findTokenByAccessHash(hash: string): Promise<StoredToken | null>;
  /**
   * Same match as findTokenByAccessHash, but ignores accessTokenExpiresAt — an expired access
   * token still names a real grant, and /revoke must be able to kill that grant (including its
   * still-live refresh token) after the access token has expired. Still excludes an already-
   * revoked row, so this can't resurrect a dead grant.
   */
  findTokenByAccessHashIgnoringExpiry(hash: string): Promise<StoredToken | null>;
  findTokenByRefreshHash(hash: string): Promise<StoredToken | null>;
  /** Returns false when the row was already revoked. Rotation relies on this for one-time use. */
  revokeToken(id: string): Promise<boolean>;
  touchToken(id: string, lastUsedAt: Date): Promise<void>;
  findShopByDomain(domain: string): Promise<ShopRef | null>;
}

/**
 * Called during the Shopify callback when `findShopByDomain` misses, with the access token just
 * exchanged for this shop -- proof the merchant controls it. Return a `ShopRef` to let the login
 * continue as if the shop had been found, or `null` to keep the install gate's 403.
 *
 * This exists for one specific case: Shopify's managed install grants the app without the merchant
 * ever opening it, so an app whose record of a shop is written when the merchant first opens the
 * embedded app has nothing yet for one who installed and went straight to an MCP client. Without
 * the hook such a merchant is refused -- for an app they have, in fact, already installed.
 *
 * A host that implements it writes that record here using the passed token: for a template-shaped
 * app that means storing the offline session (all the Shopify app template keeps), plus whatever
 * else its own install does, and then returns the resulting shop.
 *
 * The package itself never persists the token -- it is handed to this hook and dropped.
 */
export type ShopNotFoundHandler = (shop: { domain: string; accessToken: string }) => Promise<ShopRef | null>;

export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /**
   * Read and delete in a single atomic step: of two concurrent callers on the same key, exactly
   * one may see the value. This is what makes an authorization code single-use, so a get-then-del
   * implementation is not a valid substitute — required, not optional, so a non-atomic cache is
   * rejected at the type level instead of silently allowing a code to be redeemed twice.
   */
  getdel(key: string): Promise<string | null>;
}

export interface Logger {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export interface McpAuthContext {
  shopId: string | number;
  shopDomain: string;
  tokenId: string;
}

// Declared against the global Express namespace, not `declare module "express-serve-static-core"`:
// that module is only a transitive dependency of @types/express, not one of this package's own,
// so under pnpm's strict node_modules it doesn't resolve from here and tsc fails with TS2664. The
// module-scoped `Request<...>` type (what RequestHandler's `req` actually is) extends
// `Express.Request`, so augmenting the namespace below reaches it the same way.
//
// Colocated with McpAuthContext here, not with middlewares/requireAuth.ts (the function that
// actually populates `req.mcp` at runtime) -- tsup's dts bundler (rollup-plugin-dts) only includes
// a source file's declarations, ambient blocks included, when at least one of that file's OWN
// exports is reachable from the public API surface it's bundling. requireAuth.ts's only export is
// the `requireAuth` factory, which is used internally by createShopifyMcpOAuth but never
// re-exported by name -- so the whole file, augmentation included, was silently dropped from
// dist/index.d.ts, and every consumer's `req.mcp` access failed TS2339 despite compiling cleanly
// inside this package's own test suite (which compiles requireAuth.ts directly, not through the
// bundled output). types.ts's exports (McpAuthContext among them) are already re-exported from
// index.ts, which is what guarantees this file -- and this block -- survive bundling. Verified by
// compiling an external strict-mode consumer against the built dist/ output, not by reading the
// emitted .d.ts from inside this package: that check is what caught this in the first place.
declare global {
  namespace Express {
    interface Request {
      mcp?: McpAuthContext;
    }
  }
}
