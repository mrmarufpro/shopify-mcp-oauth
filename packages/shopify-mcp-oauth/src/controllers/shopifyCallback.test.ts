import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig, type ResolvedConfig } from "../config";
import { consumeCode } from "../services/codes";
import { signOuterState } from "../services/stateJwt";
import type { Logger } from "../types";
import { shopifyCallbackController } from "./shopifyCallback";

const HOST = "https://mcp.example.com";
const STATE_SECRET = "test-state-secret-at-least-32-bytes-long";
const API_SECRET_CANARY = "test-api-secret";
const DEMO_SHOP = "demo.myshopify.com";
const DEMO_SHOP_ID = "shop_1";
const CLIENT_ID = "test-client-id";
const REDIRECT_URI = "https://client.example/callback";
const CLIENT_STATE = "client-state-value";
const CODE_CHALLENGE = "challenge-value";
const CODE_CHALLENGE_METHOD = "S256";
const RESOURCE = `${HOST}/mcp`;
const SHOPIFY_ACCESS_TOKEN = "shpua_exchanged_token";

// Only the "generic 500" tests need this -- they deliberately trigger asyncHandler's error log,
// and the default console logger would print a stack trace on every full-suite run otherwise.
const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function buildConfig(
  overrides: { installed?: boolean; fetchImpl?: typeof fetch; logger?: Logger } = {}
): ResolvedConfig {
  const installed = overrides.installed ?? true;
  const storage = memoryStorage({ shops: installed ? [{ id: DEMO_SHOP_ID, domain: DEMO_SHOP }] : [] });
  const fetchImpl =
    overrides.fetchImpl ??
    (vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: SHOPIFY_ACCESS_TOKEN }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ) as unknown as typeof fetch);

  return resolveConfig({
    host: HOST,
    shopify: { apiKey: "test-api-key", apiSecret: API_SECRET_CANARY, scopes: "read_products" },
    stateSecret: STATE_SECRET,
    storage,
    fetchImpl,
    logger: overrides.logger,
  });
}

function buildApp(config: ResolvedConfig) {
  const app = express();
  // The HMAC middleware is exercised separately; this suite covers the controller itself.
  app.get("/oauth/shopify-callback", shopifyCallbackController(config));
  return app;
}

// supertest/superagent types response.headers as a plain string-keyed record, so
// noUncheckedIndexedAccess widens response.headers.location to string | undefined even though a
// 302 always sets it -- every caller here already depends on that redirect having happened.
function redirectLocation(response: request.Response): string {
  return response.headers.location ?? "";
}

function buildState(overrides: Record<string, string> = {}): string {
  return signOuterState(
    {
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      clientState: CLIENT_STATE,
      codeChallenge: CODE_CHALLENGE,
      codeChallengeMethod: CODE_CHALLENGE_METHOD,
      resource: RESOURCE,
      nonce: "nonce-value",
      ...overrides,
    },
    STATE_SECRET,
    600
  );
}

describe("shopifyCallbackController", () => {
  it("redirects back to the client with a code and its original state", async () => {
    const response = await request(buildApp(buildConfig()))
      .get("/oauth/shopify-callback")
      .query({ shop: DEMO_SHOP, code: "shopify-code", state: buildState(), hmac: "checked-elsewhere" });

    expect(response.status).toBe(302);
    const location = new URL(redirectLocation(response));
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
    expect(location.searchParams.get("state")).toBe(CLIENT_STATE);
    expect(location.searchParams.get("code")).toBeTruthy();
  });

  it("binds the issued code to the shop and the client", async () => {
    const config = buildConfig();
    const response = await request(buildApp(config))
      .get("/oauth/shopify-callback")
      .query({ shop: DEMO_SHOP, code: "shopify-code", state: buildState(), hmac: "checked-elsewhere" });

    const code = new URL(redirectLocation(response)).searchParams.get("code") ?? "";
    // Every field carried over from the verified state, not just the shop/client identity: these
    // are exactly what /token (Task 17) will check against the PKCE verifier, the redirect_uri a
    // client presents, and the resource it asks for -- a drift here is invisible until then, so
    // pin all of it here, where it's written.
    expect(await consumeCode(config, code)).toMatchObject({
      shopId: DEMO_SHOP_ID,
      shopDomain: DEMO_SHOP,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeChallenge: CODE_CHALLENGE,
      codeChallengeMethod: CODE_CHALLENGE_METHOD,
      resource: RESOURCE,
    });
  });

  it("exchanges the Shopify code against the shop's own domain", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ access_token: SHOPIFY_ACCESS_TOKEN }), { status: 200 })
      ) as unknown as typeof fetch;
    await request(buildApp(buildConfig({ fetchImpl })))
      .get("/oauth/shopify-callback")
      .query({ shop: DEMO_SHOP, code: "shopify-code", state: buildState(), hmac: "checked-elsewhere" });

    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe(`https://${DEMO_SHOP}/admin/oauth/access_token`);
  });

  it("answers 403 when the shop is not installed", async () => {
    const response = await request(buildApp(buildConfig({ installed: false })))
      .get("/oauth/shopify-callback")
      .query({ shop: DEMO_SHOP, code: "shopify-code", state: buildState(), hmac: "checked-elsewhere" });

    expect(response.status).toBe(403);
    expect(response.text).toMatch(/install/i);
  });

  it("rejects a state signed with a different secret", async () => {
    const forged = signOuterState(
      {
        clientId: CLIENT_ID,
        redirectUri: "https://attacker.example/callback",
        clientState: CLIENT_STATE,
        codeChallenge: CODE_CHALLENGE,
        codeChallengeMethod: CODE_CHALLENGE_METHOD,
        resource: RESOURCE,
        nonce: "nonce-value",
      },
      "an-entirely-different-state-secret",
      600
    );
    const response = await request(buildApp(buildConfig()))
      .get("/oauth/shopify-callback")
      .query({ shop: DEMO_SHOP, code: "shopify-code", state: forged, hmac: "checked-elsewhere" });

    expect(response.status).toBe(400);
  });

  it("rejects a shop domain outside myshopify.com", async () => {
    const response = await request(buildApp(buildConfig()))
      .get("/oauth/shopify-callback")
      .query({ shop: "attacker.example.com", code: "shopify-code", state: buildState(), hmac: "checked-elsewhere" });

    expect(response.status).toBe(400);
  });

  it("fails when Shopify's exchange returns no access token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    const response = await request(buildApp(buildConfig({ fetchImpl })))
      .get("/oauth/shopify-callback")
      .query({ shop: DEMO_SHOP, code: "shopify-code", state: buildState(), hmac: "checked-elsewhere" });

    expect(response.status).toBe(400);
  });

  it("fails when Shopify's exchange returns an error status", async () => {
    // The body is valid JSON carrying a real access_token, on purpose: this pins the exchange.ok
    // gate itself, not the access-token gate below it. The previous fixture's body ("nope") wasn't
    // valid JSON, so exchange.json() threw and the *access-token* check produced this test's 400
    // -- deleting the exchange.ok check entirely left the whole suite green. With a parseable body
    // that would otherwise satisfy every check downstream, only exchange.ok can still fail this.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ access_token: SHOPIFY_ACCESS_TOKEN }), { status: 401 })
      ) as unknown as typeof fetch;
    const response = await request(buildApp(buildConfig({ fetchImpl })))
      .get("/oauth/shopify-callback")
      .query({ shop: DEMO_SHOP, code: "shopify-code", state: buildState(), hmac: "checked-elsewhere" });

    expect(response.status).toBe(400);
  });

  it("classifies a network-level exchange failure as 400 with fixed text, never the raw error", async () => {
    // A connection-refused-style rejection from fetchImpl itself (not a Shopify response) is
    // server-side detail about how *we* tried to reach Shopify, not a judgment about the
    // merchant's request -- it must not ride the caught error's .message into the response body,
    // the same leak that cost the CIMD resolver (services/cimd.ts) a fixed-text rule of its own.
    const canaryMessage = "connect ECONNREFUSED 10.1.2.3:443";
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError(canaryMessage)) as unknown as typeof fetch;
    const response = await request(buildApp(buildConfig({ fetchImpl })))
      .get("/oauth/shopify-callback")
      .query({ shop: DEMO_SHOP, code: "shopify-code", state: buildState(), hmac: "checked-elsewhere" });

    expect(response.status).toBe(400);
    expect(response.text).not.toContain(canaryMessage);
    expect(response.text).not.toContain("10.1.2.3");
  });

  it("returns a generic 500 without leaking internal detail when the shop lookup fails", async () => {
    // findShopByDomain is our own storage, not a statement about the merchant's request -- an
    // outage there must propagate as an ordinary Error and reach asyncHandler's generic 500,
    // never be reflected into a 4xx body.
    const config = buildConfig({ logger: silentLogger });
    vi.spyOn(config.storage, "findShopByDomain").mockRejectedValue(
      new Error("storage unavailable: connection to db.internal.example refused")
    );
    const response = await request(buildApp(config))
      .get("/oauth/shopify-callback")
      .query({ shop: DEMO_SHOP, code: "shopify-code", state: buildState(), hmac: "checked-elsewhere" });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "server_error", error_description: "An unexpected error occurred" });
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain("db.internal.example");
    expect(raw).not.toContain(API_SECRET_CANARY);
    expect(raw).not.toContain(STATE_SECRET);
  });

  it("returns a generic 500 without leaking internal detail when issuing the code fails", async () => {
    // issueCode's cache write is our own infrastructure too (see services/codes.ts); a failure
    // there is symmetric with the storage case above and must land on the same generic 500 path.
    const config = buildConfig({ logger: silentLogger });
    vi.spyOn(config.cache, "set").mockRejectedValue(new Error("cache unavailable: redis.internal.example timed out"));
    const response = await request(buildApp(config))
      .get("/oauth/shopify-callback")
      .query({ shop: DEMO_SHOP, code: "shopify-code", state: buildState(), hmac: "checked-elsewhere" });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "server_error", error_description: "An unexpected error occurred" });
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain("redis.internal.example");
    expect(raw).not.toContain(API_SECRET_CANARY);
    expect(raw).not.toContain(STATE_SECRET);
  });
});
