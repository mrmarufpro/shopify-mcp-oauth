import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig, type ResolvedConfig } from "../config";
import { sha256Hex } from "../crypto";
import { issueTokens, revokeByAccessToken, revokeByRefreshToken, rotateRefresh } from "./tokens";

const DEMO_SHOP = "example.myshopify.com";
const DEMO_SHOP_ID = "shop_1";
const CLIENT_ID = "test-client-id";
const CUSTOM_SCOPE = "mcp:custom-scope";
const CUSTOM_RESOURCE = "https://mcp.example.com/custom-resource";

function buildConfig(overrides: { tokenTtl?: { access?: number; refresh?: number } } = {}): ResolvedConfig {
  return resolveConfig({
    host: "https://mcp.example.com",
    shopify: { apiKey: "test-api-key", apiSecret: "test-api-secret", scopes: "read_products" },
    stateSecret: "test-state-secret-at-least-32-bytes-long",
    storage: memoryStorage(),
    ...overrides,
  });
}

describe("issueTokens", () => {
  it("returns a Bearer bundle", async () => {
    const tokens = await issueTokens(buildConfig(), {
      shopId: DEMO_SHOP_ID,
      shopDomain: DEMO_SHOP,
      clientId: CLIENT_ID,
    });
    expect(tokens.token_type).toBe("Bearer");
  });

  it("reports the configured access lifetime", async () => {
    const config = buildConfig({ tokenTtl: { access: 900 } });
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    expect(tokens.expires_in).toBe(900);
  });

  it("stores the access token hashed, never in plaintext", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    const stored = await config.storage.findTokenByAccessHash(sha256Hex(tokens.access_token));
    expect(stored).not.toBeNull();
    expect(await config.storage.findTokenByAccessHash(tokens.access_token)).toBeNull();
  });

  it("issues distinct access and refresh tokens", async () => {
    const tokens = await issueTokens(buildConfig(), {
      shopId: DEMO_SHOP_ID,
      shopDomain: DEMO_SHOP,
      clientId: CLIENT_ID,
    });
    expect(tokens.access_token).not.toBe(tokens.refresh_token);
  });
});

describe("rotateRefresh", () => {
  it("issues a new pair, preserving the shop, scope, resource, and rotation lineage", async () => {
    const config = buildConfig();
    const first = await issueTokens(config, {
      shopId: DEMO_SHOP_ID,
      shopDomain: DEMO_SHOP,
      clientId: CLIENT_ID,
      scope: CUSTOM_SCOPE,
      resource: CUSTOM_RESOURCE,
    });
    const originalRow = await config.storage.findTokenByRefreshHash(sha256Hex(first.refresh_token));

    const rotated = await rotateRefresh(config, first.refresh_token, CLIENT_ID);
    expect(rotated).not.toBeNull();
    expect(rotated?.access_token).not.toBe(first.access_token);

    const rotatedRow = await config.storage.findTokenByAccessHash(sha256Hex(rotated?.access_token ?? ""));
    expect(rotatedRow?.shopId).toBe(DEMO_SHOP_ID);
    expect(rotatedRow?.shopDomain).toBe(DEMO_SHOP);
    expect(rotatedRow?.scope).toBe(CUSTOM_SCOPE);
    expect(rotatedRow?.resource).toBe(CUSTOM_RESOURCE);
    expect(rotatedRow?.rotatedFromId).toBe(originalRow?.id);
  });

  it("refuses the same refresh token twice", async () => {
    const config = buildConfig();
    const first = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    await rotateRefresh(config, first.refresh_token, CLIENT_ID);
    expect(await rotateRefresh(config, first.refresh_token, CLIENT_ID)).toBeNull();
  });

  it("refuses a refresh token presented by a different client", async () => {
    const config = buildConfig();
    const first = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    expect(await rotateRefresh(config, first.refresh_token, "some-other-client")).toBeNull();
  });

  it("returns null for an unknown refresh token", async () => {
    expect(await rotateRefresh(buildConfig(), "never-issued", CLIENT_ID)).toBeNull();
  });

  it("lets only one of two concurrent rotations win", async () => {
    const config = buildConfig();
    const first = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    const [a, b] = await Promise.all([
      rotateRefresh(config, first.refresh_token, CLIENT_ID),
      rotateRefresh(config, first.refresh_token, CLIENT_ID),
    ]);
    const winners = [a, b].filter((result) => result !== null);
    expect(winners).toHaveLength(1);
  });
});

describe("revokeByAccessToken", () => {
  it("makes the access token unusable", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    await revokeByAccessToken(config, tokens.access_token);
    expect(await config.storage.findTokenByAccessHash(sha256Hex(tokens.access_token))).toBeNull();
  });

  it("revokes the grant even after the access token has expired", async () => {
    vi.useFakeTimers();
    try {
      const config = buildConfig({ tokenTtl: { access: 1 } });
      const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
      vi.advanceTimersByTime(2_000);

      await revokeByAccessToken(config, tokens.access_token);

      expect(await config.storage.findTokenByRefreshHash(sha256Hex(tokens.refresh_token))).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("revokeByRefreshToken", () => {
  it("makes the refresh token unusable", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    await revokeByRefreshToken(config, tokens.refresh_token);
    expect(await config.storage.findTokenByRefreshHash(sha256Hex(tokens.refresh_token))).toBeNull();
  });

  it("also makes the paired access token unusable", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    await revokeByRefreshToken(config, tokens.refresh_token);
    expect(await config.storage.findTokenByAccessHash(sha256Hex(tokens.access_token))).toBeNull();
  });

  it("is a no-op for an unknown refresh token", async () => {
    await expect(revokeByRefreshToken(buildConfig(), "never-issued")).resolves.toBeUndefined();
  });
});
