import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig, type ResolvedConfig } from "../config";
import { sha256Hex } from "../crypto";
import { issueTokens } from "../services/tokens";
import { revokeController } from "./revoke";

const DEMO_SHOP = "example.myshopify.com";
const DEMO_SHOP_ID = "shop_1";
const CLIENT_ID = "test-client-id";

function buildApp(config: ResolvedConfig) {
  const app = express();
  app.use(express.json());
  app.post("/revoke", revokeController(config));
  return app;
}

function buildConfig(overrides: { tokenTtl?: { access?: number; refresh?: number } } = {}): ResolvedConfig {
  return resolveConfig({
    host: "https://mcp.example.com",
    shopify: { apiKey: "test-api-key", apiSecret: "test-api-secret", scopes: "read_products" },
    stateSecret: "test-state-secret-at-least-32-bytes-long",
    storage: memoryStorage(),
    ...overrides,
  });
}

describe("revokeController", () => {
  it("revokes a live access token", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    const response = await request(buildApp(config)).post("/revoke").send({ token: tokens.access_token });
    expect(response.status).toBe(200);
    expect(await config.storage.findTokenByAccessHash(sha256Hex(tokens.access_token))).toBeNull();
  });

  it("revokes a refresh token when hinted", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    await request(buildApp(config))
      .post("/revoke")
      .send({ token: tokens.refresh_token, token_type_hint: "refresh_token" });
    expect(await config.storage.findTokenByRefreshHash(sha256Hex(tokens.refresh_token))).toBeNull();
  });

  it("answers 200 for a token it has never seen, so it is not an oracle", async () => {
    const response = await request(buildApp(buildConfig())).post("/revoke").send({ token: "never-issued" });
    expect(response.status).toBe(200);
  });

  it("returns an identical body for a real token and a fake one, so the two are indistinguishable", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    const realResponse = await request(buildApp(config)).post("/revoke").send({ token: tokens.access_token });
    const fakeResponse = await request(buildApp(buildConfig())).post("/revoke").send({ token: "never-issued" });
    expect(realResponse.status).toBe(fakeResponse.status);
    expect(realResponse.body).toEqual(fakeResponse.body);
  });

  it("revokes the grant even after the access token has expired", async () => {
    vi.useFakeTimers();
    try {
      const config = buildConfig({ tokenTtl: { access: 1 } });
      const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
      vi.advanceTimersByTime(2_000);

      const response = await request(buildApp(config)).post("/revoke").send({ token: tokens.access_token });

      expect(response.status).toBe(200);
      expect(await config.storage.findTokenByRefreshHash(sha256Hex(tokens.refresh_token))).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a body with no token", async () => {
    const response = await request(buildApp(buildConfig())).post("/revoke").send({});
    expect(response.status).toBe(400);
  });

  it("serializes only the validation message, never the raw issue object", async () => {
    const response = await request(buildApp(buildConfig())).post("/revoke").send({});
    expect(typeof response.body.error_description).toBe("string");
  });
});
