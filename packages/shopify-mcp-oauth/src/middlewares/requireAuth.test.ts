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
// A shop row id distinct from DEMO_SHOP_ID, simulating a shop that uninstalled and reinstalled
// under a new row id while keeping the same domain -- see "binds shopId from the stored token"
// below. A fixture equal to DEMO_SHOP_ID couldn't tell stored.shopId and shop.id apart.
const REINSTALLED_SHOP_ID = "shop_1_after_reinstall";
// A canary distinctive enough that it can't coincidentally appear in any real header or body.
const PRESENTED_TOKEN_CANARY = "presented-token-canary-should-never-be-echoed";

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

// `downstream` stands in for the protected MCP handler this middleware guards. Every rejection
// test passes its own spy and asserts it was never called -- a 401 that still lets the request
// reach the handler underneath is a real auth bypass, not a cosmetic response-shape bug.
function buildApp(config: ResolvedConfig, downstream: () => void = () => {}) {
  const app = express();
  app.use(express.json());
  app.post("/mcp", requireAuth(config), (req, res) => {
    downstream();
    res.status(200).json(req.mcp);
  });
  return app;
}

describe("requireAuth", () => {
  it("passes a live token through, exposes the shop identity and token id, and reaches the protected handler", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    const stored = await config.storage.findTokenByAccessHash(sha256Hex(tokens.access_token));
    const downstream = vi.fn();
    const response = await request(buildApp(config, downstream))
      .post("/mcp")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({});

    expect(response.status).toBe(200);
    // Asserting the whole body (not just shopDomain/shopId) means an extra or renamed key would
    // fail this too, not just a forged value.
    expect(response.body).toEqual({ shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, tokenId: stored?.id });
    expect(downstream).toHaveBeenCalledTimes(1);
  });

  it("rejects a request with no Authorization header, and never reaches the protected handler", async () => {
    const downstream = vi.fn();
    const response = await request(buildApp(buildConfig(), downstream)).post("/mcp").send({});
    expect(response.status).toBe(401);
    expect(downstream).not.toHaveBeenCalled();
  });

  it("rejects a non-Bearer scheme, and never reaches the protected handler", async () => {
    const downstream = vi.fn();
    const response = await request(buildApp(buildConfig(), downstream))
      .post("/mcp")
      .set("Authorization", "Basic dXNlcjpwYXNz")
      .send({});
    expect(response.status).toBe(401);
    // Asserting the specific error code (not just the status) so this fails on its own scheme
    // check rather than passing incidentally because the garbage credential also happens to miss
    // the unknown-token lookup below.
    expect(response.body).toEqual({ error: "missing_bearer" });
    expect(downstream).not.toHaveBeenCalled();
  });

  it("accepts a case-insensitive Bearer scheme", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    // RFC 7235 §2.1: the scheme token is case-insensitive.
    const response = await request(buildApp(config))
      .post("/mcp")
      .set("Authorization", `bearer ${tokens.access_token}`)
      .send({});
    expect(response.status).toBe(200);
  });

  it("rejects an unknown token, and never reaches the protected handler", async () => {
    const downstream = vi.fn();
    const response = await request(buildApp(buildConfig(), downstream))
      .post("/mcp")
      .set("Authorization", "Bearer never-issued")
      .send({});
    expect(response.status).toBe(401);
    expect(downstream).not.toHaveBeenCalled();
  });

  it("rejects a revoked token, and never reaches the protected handler", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    const stored = await config.storage.findTokenByRefreshHash(sha256Hex(tokens.refresh_token));
    await config.storage.revokeToken(stored!.id);

    const downstream = vi.fn();
    const response = await request(buildApp(config, downstream))
      .post("/mcp")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({});
    expect(response.status).toBe(401);
    expect(downstream).not.toHaveBeenCalled();
  });

  it("rejects an access token past its expiry, and never reaches the protected handler", async () => {
    vi.useFakeTimers();
    try {
      const config = buildConfig({ tokenTtl: { access: 1 } });
      const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
      vi.advanceTimersByTime(2_000);

      const downstream = vi.fn();
      const response = await request(buildApp(config, downstream))
        .post("/mcp")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .send({});
      expect(response.status).toBe(401);
      expect(downstream).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a token minted for a different resource server, and never reaches the protected handler", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, {
      shopId: DEMO_SHOP_ID,
      shopDomain: DEMO_SHOP,
      clientId: CLIENT_ID,
      resource: OTHER_TENANT_RESOURCE,
    });
    const downstream = vi.fn();
    const response = await request(buildApp(config, downstream))
      .post("/mcp")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({});
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "invalid_token" });
    expect(downstream).not.toHaveBeenCalled();
  });

  it("rejects a token whose stored resource is null, and never reaches the protected handler", async () => {
    const config = buildConfig();
    const rawToken = "raw-null-resource-token";
    // Written directly through storage.createToken, not issueTokens -- issueTokens always
    // defaults resource to config.resource, so it can never produce this row. A storage adapter
    // populated by a hand migration or an older schema version could still hold one.
    await config.storage.createToken({
      shopId: DEMO_SHOP_ID,
      shopDomain: DEMO_SHOP,
      clientId: CLIENT_ID,
      accessTokenHash: sha256Hex(rawToken),
      refreshTokenHash: null,
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenExpiresAt: null,
      scope: "mcp:*",
      resource: null,
      rotatedFromId: null,
    });

    const downstream = vi.fn();
    const response = await request(buildApp(config, downstream))
      .post("/mcp")
      .set("Authorization", `Bearer ${rawToken}`)
      .send({});
    expect(response.status).toBe(401);
    expect(downstream).not.toHaveBeenCalled();
  });

  it("rejects a token whose shop has since been uninstalled, and never reaches the protected handler", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, {
      shopId: "shop_gone",
      shopDomain: "uninstalled.myshopify.com",
      clientId: CLIENT_ID,
    });
    const downstream = vi.fn();
    const response = await request(buildApp(config, downstream))
      .post("/mcp")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({});
    expect(response.status).toBe(401);
    expect(downstream).not.toHaveBeenCalled();
  });

  it("binds shopId from the stored token, not a freshly looked-up shop row (fails closed after a reinstall)", async () => {
    // The seeded shop row's id differs from the id the token itself carries -- simulating a shop
    // that uninstalled and reinstalled under a new row id after this token was minted. Design
    // ruling: the response must carry the token's own (stale) shopId, not the fresh row's id --
    // binding to the fresh row would let a pre-reinstall token silently reach the new
    // installation.
    const config = resolveConfig({
      host: HOST,
      shopify: { apiKey: "test-api-key", apiSecret: API_SECRET_CANARY, scopes: "read_products" },
      stateSecret: STATE_SECRET_CANARY,
      storage: memoryStorage({ shops: [{ id: REINSTALLED_SHOP_ID, domain: DEMO_SHOP }] }),
    });
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });

    const response = await request(buildApp(config))
      .post("/mcp")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.shopId).toBe(DEMO_SHOP_ID);
    expect(response.body.shopId).not.toBe(REINSTALLED_SHOP_ID);
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

  it("never echoes the presented token into the WWW-Authenticate header", async () => {
    const response = await request(buildApp(buildConfig()))
      .post("/mcp")
      .set("Authorization", `Bearer ${PRESENTED_TOKEN_CANARY}`)
      .send({});
    expect(response.headers["www-authenticate"]).not.toContain(PRESENTED_TOKEN_CANARY);
  });

  it("returns a generic 500 without leaking storage error details when the token store fails", async () => {
    const config = buildConfig({ logger: silentLogger });
    vi.spyOn(config.storage, "findTokenByAccessHash").mockRejectedValue(
      new Error("storage unavailable: connection to db.internal.example refused")
    );
    const response = await request(buildApp(config)).post("/mcp").set("Authorization", "Bearer some-token").send({});
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "server_error", error_description: "An unexpected error occurred" });
    // Checked against the raw response text, not JSON.stringify(response.body): a leak that
    // escapes asyncHandler (e.g. Express's own default error handler rendering an HTML stack
    // trace when nothing wraps the failing handler) leaves response.body as {} for a non-JSON
    // content type, which would make a body-based assertion pass trivially while the secret is
    // still on the wire.
    expect(response.text).not.toContain("db.internal.example");
    expect(response.text).not.toContain(API_SECRET_CANARY);
    expect(response.text).not.toContain(STATE_SECRET_CANARY);
  });
});
