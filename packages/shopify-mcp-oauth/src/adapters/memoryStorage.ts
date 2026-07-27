import { randomBase64Url } from "../crypto";
import type { NewOAuthClient, NewToken, OAuthClient, OAuthStorage, ShopRef, StoredToken } from "../types";

export interface MemoryStorage extends OAuthStorage {
  addShop(shop: ShopRef): void;
}

export function memoryStorage(seed: { shops?: ShopRef[] } = {}): MemoryStorage {
  const clients = new Map<string, OAuthClient>();
  const tokens = new Map<string, StoredToken>();
  const shops = new Map<string, ShopRef>();
  for (const shop of seed.shops ?? []) shops.set(shop.domain, shop);

  function isUsable(token: StoredToken): boolean {
    return token.revokedAt === null && token.accessTokenExpiresAt.getTime() > Date.now();
  }

  return {
    addShop(shop) {
      shops.set(shop.domain, shop);
    },

    async findClient(clientId) {
      return clients.get(clientId) ?? null;
    },

    async createClient(client) {
      const row: OAuthClient = { ...client, revokedAt: null };
      clients.set(row.clientId, row);
      return row;
    },

    async upsertClient(client: NewOAuthClient) {
      const existing = clients.get(client.clientId);
      if (existing) return existing;
      const row: OAuthClient = { ...client, revokedAt: null };
      clients.set(row.clientId, row);
      return row;
    },

    async createToken(token: NewToken) {
      const row: StoredToken = { ...token, id: randomBase64Url(12), revokedAt: null };
      tokens.set(row.id, row);
      return row;
    },

    async findTokenByAccessHash(hash) {
      for (const token of tokens.values()) {
        if (token.accessTokenHash === hash && isUsable(token)) return token;
      }
      return null;
    },

    async findTokenByRefreshHash(hash) {
      for (const token of tokens.values()) {
        if (token.refreshTokenHash !== hash) continue;
        if (token.revokedAt !== null) continue;
        if (token.refreshTokenExpiresAt && token.refreshTokenExpiresAt.getTime() <= Date.now()) continue;
        return token;
      }
      return null;
    },

    async revokeToken(id) {
      const token = tokens.get(id);
      if (!token || token.revokedAt !== null) return false;
      tokens.set(id, { ...token, revokedAt: new Date() });
      return true;
    },

    async touchToken() {
      // last-used tracking is not useful in memory; the contract only requires it not to throw
    },

    async findShopByDomain(domain) {
      return shops.get(domain) ?? null;
    },
  };
}
