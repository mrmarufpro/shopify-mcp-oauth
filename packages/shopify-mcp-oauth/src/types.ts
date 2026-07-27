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
  findTokenByRefreshHash(hash: string): Promise<StoredToken | null>;
  /** Returns false when the row was already revoked. Rotation relies on this for one-time use. */
  revokeToken(id: string): Promise<boolean>;
  touchToken(id: string, lastUsedAt: Date): Promise<void>;
  findShopByDomain(domain: string): Promise<ShopRef | null>;
}

export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Atomic read-and-delete when the backend supports it. Falls back to get+del. */
  getdel?(key: string): Promise<string | null>;
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
