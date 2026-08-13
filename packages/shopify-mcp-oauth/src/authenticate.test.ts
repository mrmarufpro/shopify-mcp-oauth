import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "./adapters/memoryStorage";
import { createAuthenticator } from "./authenticate";
import { resolveConfig, type ResolvedConfig } from "./config";
import { sha256Hex } from "./crypto";
import { issueTokens } from "./services/tokens";

const HOST = "https://mcp.example.com";
const DEMO_SHOP = "demo.myshopify.com";
const DEMO_SHOP_ID = "shop_1";
const CLIENT_ID = "test-client-id";
const OTHER_TENANT_RESOURCE = `${HOST}/mcp/other-tenant`;

function buildConfig(): ResolvedConfig {
  return resolveConfig({
    host: HOST,
    shopify: { apiKey: "test-api-key", apiSecret: "test-api-secret", scopes: "read_products" },
    stateSecret: "test-state-secret-at-least-32-bytes-long",
    storage: memoryStorage({ shops: [{ id: DEMO_SHOP_ID, domain: DEMO_SHOP }] }),
  });
}

/** Only the two methods `challenge` touches — enough to assert what it wrote without a real server. */
function buildFakeResponse(headersSent = false) {
  const headers: Record<string, string> = {};
  const response = {
    headersSent,
    // Throws the way a real ServerResponse does once headers are flushed, so a missing guard shows
    // up here as the same error it would be in production rather than as a silent no-op.
    setHeader: vi.fn((name: string, value: string) => {
      if (response.headersSent) throw new Error("ERR_HTTP_HEADERS_SENT");
      headers[name] = value;
    }),
    status: vi.fn(() => response),
    json: vi.fn(() => response),
  };
  return { response: response as unknown as Response, headers, spies: response };
}

describe("authenticate", () => {
  it("resolves the shop identity and token id from a live access token", async () => {
    const config = buildConfig();
    const { authenticate } = createAuthenticator(config);
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    const stored = await config.storage.findTokenByAccessHash(sha256Hex(tokens.access_token));

    const result = await authenticate({ headers: { authorization: `Bearer ${tokens.access_token}` } });

    expect(result).toEqual({ ok: true, context: { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, tokenId: stored?.id } });
  });

  it("reports missing_bearer when there is no Authorization header", async () => {
    const { authenticate } = createAuthenticator(buildConfig());
    expect(await authenticate({ headers: {} })).toEqual({ ok: false, reason: "missing_bearer" });
  });

  it("reports missing_bearer for a non-Bearer scheme", async () => {
    const { authenticate } = createAuthenticator(buildConfig());
    expect(await authenticate({ headers: { authorization: "Basic dXNlcjpwYXNz" } })).toEqual({
      ok: false,
      reason: "missing_bearer",
    });
  });

  it("reports invalid_token for a token this server never issued", async () => {
    const { authenticate } = createAuthenticator(buildConfig());
    expect(await authenticate({ headers: { authorization: "Bearer never-issued" } })).toEqual({
      ok: false,
      reason: "invalid_token",
    });
  });

  it("reports invalid_token for a token minted for a different resource server", async () => {
    const config = buildConfig();
    const { authenticate } = createAuthenticator(config);
    const tokens = await issueTokens(config, {
      shopId: DEMO_SHOP_ID,
      shopDomain: DEMO_SHOP,
      clientId: CLIENT_ID,
      resource: OTHER_TENANT_RESOURCE,
    });

    expect(await authenticate({ headers: { authorization: `Bearer ${tokens.access_token}` } })).toEqual({
      ok: false,
      reason: "invalid_token",
    });
  });

  // A host composing this with a second scheme runs it inside its own middleware; a storage outage
  // must reach that middleware's error path rather than being flattened into "invalid_token",
  // which would tell the client to start a fresh login for a fault no login can fix.
  it("propagates a storage failure instead of reporting it as invalid_token", async () => {
    const config = buildConfig();
    vi.spyOn(config.storage, "findTokenByAccessHash").mockRejectedValue(new Error("storage unavailable"));
    const { authenticate } = createAuthenticator(config);

    await expect(authenticate({ headers: { authorization: "Bearer some-token" } })).rejects.toThrow(
      "storage unavailable"
    );
  });
});

describe("challenge", () => {
  it("answers 401 with a resource-metadata pointer and the given reason", () => {
    const { challenge } = createAuthenticator(buildConfig());
    const { response, headers, spies } = buildFakeResponse();

    challenge(response, "missing_bearer");

    expect(spies.status).toHaveBeenCalledWith(401);
    expect(spies.json).toHaveBeenCalledWith({ error: "missing_bearer" });
    expect(headers["WWW-Authenticate"]).toBe(
      `Bearer error="missing_bearer", resource_metadata="${HOST}/.well-known/oauth-protected-resource"`
    );
  });

  // The common call site is a host's own auth middleware that has already decided the request is
  // unauthenticated for its own reasons (a bad PAT, say) and just needs the RFC 9728 challenge.
  it("defaults to invalid_token when no reason is given", () => {
    const { challenge } = createAuthenticator(buildConfig());
    const { response, headers } = buildFakeResponse();

    challenge(response);

    expect(headers["WWW-Authenticate"]).toContain('error="invalid_token"');
  });

  // requireAuth can only reach challenge before anything is written, but the composition pattern
  // this package documents hands it to host code that ran its own credential scheme first -- and
  // that scheme may already have answered, streamed, or timed out. There is nothing wrapped around
  // the host's middleware to catch a throw from here, so it would surface as an unhandled rejection
  // or a hung request in place of the 401 it was meant to send.
  it("does nothing instead of throwing when the response has already been sent", () => {
    const { challenge } = createAuthenticator(buildConfig());
    const { response, spies } = buildFakeResponse(true);

    expect(() => challenge(response, "invalid_token")).not.toThrow();
    expect(spies.setHeader).not.toHaveBeenCalled();
    expect(spies.status).not.toHaveBeenCalled();
  });
});
