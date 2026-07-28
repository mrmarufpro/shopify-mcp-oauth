import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig, type ResolvedConfig } from "../config";
import { sha256Hex } from "../crypto";
import { issueTokens } from "../services/tokens";
import type { Logger } from "../types";
import { requireAuth } from "./requireAuth";

const HOST = "https://mcp.example.com";
const DEMO_SHOP = "demo.myshopify.com";
const DEMO_SHOP_ID = "shop_1";
const CLIENT_ID = "test-client-id";
const API_SECRET_CANARY = "test-api-secret";
const STATE_SECRET_CANARY = "test-state-secret-at-least-32-bytes-long";
// Deliberately not `${HOST}/mcp` (what resolveConfig derives as config.resource) -- a fixture
// that coincided with the default would pass even if the audience check were deleted entirely.
const OTHER_TENANT_RESOURCE = `${HOST}/mcp/other-tenant`;

// Only the "generic 500" test needs this -- it deliberately triggers asyncHandler's error log,
// and the default console logger would print a stack trace on every full-suite run otherwise.
const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function buildConfig(
  overrides: { logger?: Logger; tokenTtl?: { access?: number; refresh?: number } } = {}
): ResolvedConfig {
  return resolveConfig({
    host: HOST,
    shopify: { apiKey: "test-api-key", apiSecret: API_SECRET_CANARY, scopes: "read_products" },
    stateSecret: STATE_SECRET_CANARY,
    storage: memoryStorage({ shops: [{ id: DEMO_SHOP_ID, domain: DEMO_SHOP }] }),
    ...overrides,
  });
}

function buildApp(config: ResolvedConfig) {
  const app = express();
  app.use(express.json());
  app.post("/mcp", requireAuth(config), (req, res) => {
    res.status(200).json(req.mcp);
  });
  return app;
}

describe("requireAuth", () => {
  it("passes a live token through and exposes the shop identity and token id, not a forgeable default", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    const stored = await config.storage.findTokenByAccessHash(sha256Hex(tokens.access_token));
    const response = await request(buildApp(config))
      .post("/mcp")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({});

    expect(response.status).toBe(200);
    // Asserting the whole body (not just shopDomain/shopId) means an extra or renamed key would
    // fail this too, not just a forged value.
    expect(response.body).toEqual({ shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, tokenId: stored?.id });
  });

  it("rejects a request with no Authorization header", async () => {
    const response = await request(buildApp(buildConfig())).post("/mcp").send({});
    expect(response.status).toBe(401);
  });

  it("rejects a non-Bearer scheme", async () => {
    const response = await request(buildApp(buildConfig()))
      .post("/mcp")
      .set("Authorization", "Basic dXNlcjpwYXNz")
      .send({});
    expect(response.status).toBe(401);
    // Asserting the specific error code (not just the status) so this fails on its own scheme
    // check rather than passing incidentally because the garbage credential also happens to miss
    // the unknown-token lookup below.
    expect(response.body).toEqual({ error: "missing_bearer" });
  });

  it("rejects an unknown token", async () => {
    const response = await request(buildApp(buildConfig()))
      .post("/mcp")
      .set("Authorization", "Bearer never-issued")
      .send({});
    expect(response.status).toBe(401);
  });

  it("rejects a revoked token", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    const stored = await config.storage.findTokenByRefreshHash(sha256Hex(tokens.refresh_token));
    await config.storage.revokeToken(stored!.id);

    const response = await request(buildApp(config))
      .post("/mcp")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({});
    expect(response.status).toBe(401);
  });

  it("rejects an access token past its expiry", async () => {
    vi.useFakeTimers();
    try {
      const config = buildConfig({ tokenTtl: { access: 1 } });
      const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
      vi.advanceTimersByTime(2_000);

      const response = await request(buildApp(config))
        .post("/mcp")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .send({});
      expect(response.status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a token minted for a different resource server", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, {
      shopId: DEMO_SHOP_ID,
      shopDomain: DEMO_SHOP,
      clientId: CLIENT_ID,
      resource: OTHER_TENANT_RESOURCE,
    });
    const response = await request(buildApp(config))
      .post("/mcp")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({});
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "invalid_token" });
  });

  it("rejects a token whose shop has since been uninstalled", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, {
      shopId: "shop_gone",
      shopDomain: "uninstalled.myshopify.com",
      clientId: CLIENT_ID,
    });
    const response = await request(buildApp(config))
      .post("/mcp")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({});
    expect(response.status).toBe(401);
  });

  it("points a 401 at the protected-resource metadata document when the header is missing", async () => {
    const response = await request(buildApp(buildConfig())).post("/mcp").send({});
    expect(response.headers["www-authenticate"]).toContain(`${HOST}/.well-known/oauth-protected-resource`);
    expect(response.headers["www-authenticate"]).toContain('error="missing_bearer"');
  });

  it("points a 401 at the protected-resource metadata document when the token is invalid", async () => {
    const response = await request(buildApp(buildConfig()))
      .post("/mcp")
      .set("Authorization", "Bearer never-issued")
      .send({});
    expect(response.headers["www-authenticate"]).toContain(`${HOST}/.well-known/oauth-protected-resource`);
    expect(response.headers["www-authenticate"]).toContain('error="invalid_token"');
  });

  it("returns a generic 500 without leaking storage error details when the token store fails", async () => {
    const config = buildConfig({ logger: silentLogger });
    vi.spyOn(config.storage, "findTokenByAccessHash").mockRejectedValue(
      new Error("storage unavailable: connection to db.internal.example refused")
    );
    const response = await request(buildApp(config)).post("/mcp").set("Authorization", "Bearer some-token").send({});
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "server_error", error_description: "An unexpected error occurred" });
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain("db.internal.example");
    expect(raw).not.toContain(API_SECRET_CANARY);
    expect(raw).not.toContain(STATE_SECRET_CANARY);
  });
});
