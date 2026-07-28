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
const API_SECRET_CANARY = "test-api-secret";
const STATE_SECRET_CANARY = "test-state-secret-at-least-32-bytes-long";

function buildApp(config: ResolvedConfig) {
  const app = express();
  app.use(express.json());
  app.post("/revoke", revokeController(config));
  return app;
}

function buildConfig(overrides: { tokenTtl?: { access?: number; refresh?: number } } = {}): ResolvedConfig {
  return resolveConfig({
    host: "https://mcp.example.com",
    shopify: { apiKey: "test-api-key", apiSecret: API_SECRET_CANARY, scopes: "read_products" },
    stateSecret: STATE_SECRET_CANARY,
    storage: memoryStorage(),
    ...overrides,
  });
}

// Headers carry state too (F2b) — strip only Date, which ticks between requests regardless of
// what happened, and would otherwise make two truly-identical responses look different.
function headersMinusDate(response: request.Response): Record<string, string> {
  const { date: _date, ...rest } = response.headers as Record<string, string>;
  return rest;
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
    const response = await request(buildApp(config))
      .post("/revoke")
      .send({ token: tokens.refresh_token, token_type_hint: "refresh_token" });
    expect(response.status).toBe(200);
    expect(await config.storage.findTokenByRefreshHash(sha256Hex(tokens.refresh_token))).toBeNull();
  });

  it("answers 200 for a token it has never seen, so it is not an oracle", async () => {
    const response = await request(buildApp(buildConfig())).post("/revoke").send({ token: "never-issued" });
    expect(response.status).toBe(200);
  });

  it("returns an identical status, body, and headers for a real token and a fake one, so the two are indistinguishable", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    const realResponse = await request(buildApp(config)).post("/revoke").send({ token: tokens.access_token });
    const fakeResponse = await request(buildApp(buildConfig())).post("/revoke").send({ token: "never-issued" });
    expect(realResponse.status).toBe(fakeResponse.status);
    expect(realResponse.body).toEqual(fakeResponse.body);
    expect(headersMinusDate(realResponse)).toEqual(headersMinusDate(fakeResponse));
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
    expect(response.body.error_description).toBe("token is required");
  });

  it("returns a generic 500 without a stack trace when the token store fails", async () => {
    const config = buildConfig();
    vi.spyOn(config.storage, "findTokenByAccessHashIgnoringExpiry").mockRejectedValue(
      new Error("storage unavailable: connection to db.internal.example refused")
    );
    const response = await request(buildApp(config)).post("/revoke").send({ token: "some-token" });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "server_error", error_description: "An unexpected error occurred" });
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain("db.internal.example");
    expect(raw).not.toContain(API_SECRET_CANARY);
    expect(raw).not.toContain(STATE_SECRET_CANARY);
  });
});
