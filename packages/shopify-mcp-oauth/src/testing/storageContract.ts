import { beforeEach, describe, expect, it } from "vitest";
import type { NewOAuthClient, NewToken, OAuthStorage, ShopRef } from "../types";

const CONTRACT_CLIENT_ID = "contract-client-id";
const CONTRACT_REDIRECT_URI = "https://client.example/callback";

function buildClient(overrides: Partial<NewOAuthClient> = {}): NewOAuthClient {
  return {
    clientId: CONTRACT_CLIENT_ID,
    clientName: null,
    redirectUris: [CONTRACT_REDIRECT_URI],
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    logoUri: null,
    clientUri: null,
    tokenEndpointAuthMethod: "none",
    ...overrides,
  };
}

function buildToken(shop: ShopRef, overrides: Partial<NewToken> = {}): NewToken {
  return {
    shopId: shop.id,
    shopDomain: shop.domain,
    clientId: CONTRACT_CLIENT_ID,
    accessTokenHash: "access-hash",
    refreshTokenHash: "refresh-hash",
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
    scope: "mcp:*",
    resource: "https://mcp.example.com/mcp",
    rotatedFromId: null,
    ...overrides,
  };
}

export function runStorageContractTests(
  makeStorage: () => Promise<OAuthStorage> | OAuthStorage,
  opts: { seedShop: ShopRef }
): void {
  describe("OAuthStorage contract", () => {
    let storage: OAuthStorage;

    beforeEach(async () => {
      storage = await makeStorage();
    });

    it("returns null for an unknown client", async () => {
      expect(await storage.findClient("no-such-client")).toBeNull();
    });

    it("round-trips a created client", async () => {
      await storage.createClient(buildClient({ clientName: "Contract Client", redirectUris: [CONTRACT_REDIRECT_URI] }));
      const found = await storage.findClient(CONTRACT_CLIENT_ID);
      expect(found?.clientName).toBe("Contract Client");
      expect(found?.redirectUris).toEqual([CONTRACT_REDIRECT_URI]);
    });

    it("upsertClient is idempotent on clientId", async () => {
      await storage.upsertClient(buildClient({ clientName: "First Write" }));
      await storage.upsertClient(buildClient({ clientName: "Second Write" }));
      const found = await storage.findClient(CONTRACT_CLIENT_ID);
      expect(found?.clientName).toBe("First Write");
    });

    it("finds a token by its access hash", async () => {
      await storage.createToken(
        buildToken(opts.seedShop, { accessTokenHash: "lookup-me", clientId: CONTRACT_CLIENT_ID })
      );
      const found = await storage.findTokenByAccessHash("lookup-me");
      expect(found?.clientId).toBe(CONTRACT_CLIENT_ID);
    });

    it("returns null for an access hash that was never stored", async () => {
      expect(await storage.findTokenByAccessHash("never-stored-access-hash")).toBeNull();
    });

    it("does not return an expired access token", async () => {
      await storage.createToken(
        buildToken(opts.seedShop, {
          accessTokenHash: "expired-hash",
          accessTokenExpiresAt: new Date(Date.now() - 1000),
        })
      );
      expect(await storage.findTokenByAccessHash("expired-hash")).toBeNull();
    });

    it("does not return a revoked token by its access hash", async () => {
      const token = await storage.createToken(buildToken(opts.seedShop, { accessTokenHash: "revoke-me" }));
      await storage.revokeToken(token.id);
      expect(await storage.findTokenByAccessHash("revoke-me")).toBeNull();
    });

    it("finds a token by its refresh hash", async () => {
      await storage.createToken(
        buildToken(opts.seedShop, { refreshTokenHash: "refresh-lookup", clientId: CONTRACT_CLIENT_ID })
      );
      const found = await storage.findTokenByRefreshHash("refresh-lookup");
      expect(found?.clientId).toBe(CONTRACT_CLIENT_ID);
    });

    it("returns null for a refresh hash that was never stored", async () => {
      expect(await storage.findTokenByRefreshHash("never-stored-refresh-hash")).toBeNull();
    });

    it("does not return an expired refresh token", async () => {
      await storage.createToken(
        buildToken(opts.seedShop, {
          refreshTokenHash: "expired-refresh-hash",
          refreshTokenExpiresAt: new Date(Date.now() - 1000),
        })
      );
      expect(await storage.findTokenByRefreshHash("expired-refresh-hash")).toBeNull();
    });

    it("does not return a revoked token by its refresh hash", async () => {
      const token = await storage.createToken(buildToken(opts.seedShop, { refreshTokenHash: "revoke-refresh-me" }));
      await storage.revokeToken(token.id);
      expect(await storage.findTokenByRefreshHash("revoke-refresh-me")).toBeNull();
    });

    it("revokeToken returns false the second time, so rotation stays single-use", async () => {
      const token = await storage.createToken(buildToken(opts.seedShop));
      expect(await storage.revokeToken(token.id)).toBe(true);
      expect(await storage.revokeToken(token.id)).toBe(false);
    });

    it("revokeToken returns false for a token id that was never created", async () => {
      expect(await storage.revokeToken("never-created-token-id")).toBe(false);
    });

    it("touchToken does not throw for an existing token", async () => {
      const token = await storage.createToken(buildToken(opts.seedShop));
      // No expect(): StoredToken has no lastUsedAt field, so resolving without throwing
      // is the only behavior this interface exposes for touchToken.
      await storage.touchToken(token.id, new Date());
    });

    it("finds the seeded shop by domain", async () => {
      const found = await storage.findShopByDomain(opts.seedShop.domain);
      expect(found?.domain).toBe(opts.seedShop.domain);
    });

    it("returns null for an unknown shop domain", async () => {
      expect(await storage.findShopByDomain("never-installed.myshopify.com")).toBeNull();
    });
  });
}
