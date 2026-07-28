import { randomBase64Url } from "../crypto";
import type { NewOAuthClient, NewToken, OAuthClient, OAuthStorage, ShopRef, StoredToken } from "../types";

export interface MemoryStorage extends OAuthStorage {
  addShop(shop: ShopRef): void;
}

// Every read and write below goes through these clones so the Map never shares an array,
// Date, or ShopRef instance with a caller — a caller mutating a returned or passed-in object
// must never corrupt what's stored, and vice versa.
function cloneShop(shop: ShopRef): ShopRef {
  return { ...shop };
}

function cloneClient(client: OAuthClient): OAuthClient {
  return {
    ...client,
    redirectUris: [...client.redirectUris],
    grantTypes: client.grantTypes ? [...client.grantTypes] : null,
    responseTypes: client.responseTypes ? [...client.responseTypes] : null,
    revokedAt: client.revokedAt ? new Date(client.revokedAt) : null,
  };
}

function cloneToken(token: StoredToken): StoredToken {
  return {
    ...token,
    accessTokenExpiresAt: new Date(token.accessTokenExpiresAt),
    refreshTokenExpiresAt: token.refreshTokenExpiresAt ? new Date(token.refreshTokenExpiresAt) : null,
    revokedAt: token.revokedAt ? new Date(token.revokedAt) : null,
  };
}

export function memoryStorage(seed: { shops?: ShopRef[] } = {}): MemoryStorage {
  const clients = new Map<string, OAuthClient>();
  const tokens = new Map<string, StoredToken>();
  const shops = new Map<string, ShopRef>();
  for (const shop of seed.shops ?? []) shops.set(shop.domain, cloneShop(shop));

  function isUsable(token: StoredToken): boolean {
    return token.revokedAt === null && token.accessTokenExpiresAt.getTime() > Date.now();
  }

  return {
    addShop(shop) {
      shops.set(shop.domain, cloneShop(shop));
    },

    async findClient(clientId) {
      const found = clients.get(clientId);
      return found ? cloneClient(found) : null;
    },

    async createClient(client) {
      const row: OAuthClient = cloneClient({ ...client, revokedAt: null });
      clients.set(row.clientId, row);
      return cloneClient(row);
    },

    async upsertClient(client: NewOAuthClient) {
      const existing = clients.get(client.clientId);
      if (existing) return cloneClient(existing);
      const row: OAuthClient = cloneClient({ ...client, revokedAt: null });
      clients.set(row.clientId, row);
      return cloneClient(row);
    },

    async createToken(token: NewToken) {
      const row: StoredToken = cloneToken({ ...token, id: randomBase64Url(12), revokedAt: null });
      tokens.set(row.id, row);
      return cloneToken(row);
    },

    async findTokenByAccessHash(hash) {
      for (const token of tokens.values()) {
        if (token.accessTokenHash === hash && isUsable(token)) return cloneToken(token);
      }
      return null;
    },

    async findTokenByRefreshHash(hash) {
      for (const token of tokens.values()) {
        if (token.refreshTokenHash !== hash) continue;
        if (token.revokedAt !== null) continue;
        if (token.refreshTokenExpiresAt && token.refreshTokenExpiresAt.getTime() <= Date.now()) continue;
        return cloneToken(token);
      }
      return null;
    },

    async revokeToken(id) {
      const token = tokens.get(id);
      if (!token || token.revokedAt !== null) return false;
      tokens.set(id, { ...cloneToken(token), revokedAt: new Date() });
      return true;
    },

    async touchToken() {
      // last-used tracking is not useful in memory; the contract only requires it not to throw
    },

    async findShopByDomain(domain) {
      const found = shops.get(domain);
      return found ? cloneShop(found) : null;
    },
  };
}
