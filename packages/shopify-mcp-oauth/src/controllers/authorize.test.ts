import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig, type ResolvedConfig } from "../config";
import { verifyOuterState } from "../services/stateJwt";
import type { Logger } from "../types";
import { authorizeController } from "./authorize";

const HOST = "https://mcp.example.com";
const STATE_SECRET = "test-state-secret-at-least-32-bytes-long";
const SHOPIFY_API_KEY = "test-api-key";
const API_SECRET_CANARY = "test-api-secret";
const CIMD_URL = "https://client.example/metadata.json";
const REDIRECT_URI = "https://client.example/callback";
const CLIENT_STATE = "client-state-value";
// authorizeQuerySchema requires code_challenge to be exactly 43 characters (base64url(SHA-256(...))
// with no padding) — this isn't a real SHA-256 output, but it satisfies the shape check, and no
// test here redeems the code, so the shape is all that matters.
const CODE_CHALLENGE = "test-code-challenge-value-12345678901234567";

// Only the "generic 500" test needs this — it deliberately triggers asyncHandler's error log,
// and the default console logger would print a stack trace on every full-suite run otherwise.
const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function buildConfig(overrides: { logger?: Logger } = {}): ResolvedConfig {
  const cimdResponse = new Response(JSON.stringify({ client_name: "Test Client", redirect_uris: [REDIRECT_URI] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  return resolveConfig({
    host: HOST,
    shopify: { apiKey: SHOPIFY_API_KEY, apiSecret: API_SECRET_CANARY, scopes: "read_products" },
    stateSecret: STATE_SECRET,
    storage: memoryStorage(),
    fetchImpl: vi.fn().mockResolvedValue(cimdResponse) as unknown as typeof fetch,
    ...overrides,
  });
}

function buildApp(config: ResolvedConfig) {
  const app = express();
  app.get("/authorize", authorizeController(config, { allowPrivateCimdHosts: true }));
  return app;
}

// supertest/superagent types response.headers as a plain string-keyed record, so
// noUncheckedIndexedAccess widens response.headers.location to string | undefined even though a
// 302 always sets it — every caller here already depends on that redirect having happened.
function redirectLocation(response: request.Response): string {
  return response.headers.location ?? "";
}

const validQuery = {
  response_type: "code",
  client_id: CIMD_URL,
  redirect_uri: REDIRECT_URI,
  state: CLIENT_STATE,
  code_challenge: CODE_CHALLENGE,
  code_challenge_method: "S256",
};

describe("authorizeController", () => {
  it("redirects to Shopify's shop picker", async () => {
    const response = await request(buildApp(buildConfig())).get("/authorize").query(validQuery);
    expect(response.status).toBe(302);
    expect(response.headers.location).toContain("https://admin.shopify.com/");
  });

  it("asks Shopify for our app, with our callback", async () => {
    const response = await request(buildApp(buildConfig())).get("/authorize").query(validQuery);
    const redirectParam = new URL(redirectLocation(response)).searchParams.get("redirect") ?? "";
    expect(redirectParam).toContain(`client_id=${SHOPIFY_API_KEY}`);
    expect(redirectParam).toContain(encodeURIComponent(`${HOST}/oauth/shopify-callback`));
  });

  it("carries the original request inside a signed state JWT", async () => {
    const response = await request(buildApp(buildConfig())).get("/authorize").query(validQuery);
    const redirectParam = new URL(redirectLocation(response)).searchParams.get("redirect") ?? "";
    const stateJwt = new URLSearchParams(redirectParam.split("?")[1]).get("state") ?? "";
    const verified = verifyOuterState(stateJwt, STATE_SECRET);
    expect(verified.clientId).toBe(CIMD_URL);
    expect(verified.redirectUri).toBe(REDIRECT_URI);
    expect(verified.clientState).toBe(CLIENT_STATE);
    expect(verified.codeChallenge).toBe(CODE_CHALLENGE);
  });

  it("rejects a redirect_uri the client did not register", async () => {
    const response = await request(buildApp(buildConfig()))
      .get("/authorize")
      .query({ ...validQuery, redirect_uri: "https://attacker.example/callback" });
    expect(response.status).toBe(400);
    expect(response.body.error_description).toMatch(/not registered/);
  });

  it("rejects a resource that is not ours", async () => {
    const response = await request(buildApp(buildConfig()))
      .get("/authorize")
      .query({ ...validQuery, resource: "https://other.example/mcp" });
    expect(response.status).toBe(400);
  });

  it("accepts our canonical resource", async () => {
    const response = await request(buildApp(buildConfig()))
      .get("/authorize")
      .query({ ...validQuery, resource: `${HOST}/mcp` });
    expect(response.status).toBe(302);
  });

  it("rejects a plain code_challenge_method", async () => {
    const response = await request(buildApp(buildConfig()))
      .get("/authorize")
      .query({ ...validQuery, code_challenge_method: "plain" });
    expect(response.status).toBe(400);
  });

  it("rejects an unknown registered client_id", async () => {
    const response = await request(buildApp(buildConfig()))
      .get("/authorize")
      .query({ ...validQuery, client_id: "never-registered" });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_client");
  });

  it("accepts a client registered through DCR", async () => {
    const config = buildConfig();
    const registered = await config.storage.createClient({
      clientId: "registered-client-id",
      clientName: "Registered Client",
      redirectUris: [REDIRECT_URI],
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      logoUri: null,
      clientUri: null,
      tokenEndpointAuthMethod: "none",
    });
    const response = await request(buildApp(config))
      .get("/authorize")
      .query({ ...validQuery, client_id: registered.clientId });
    expect(response.status).toBe(302);
  });

  it("serializes only the validation message, never the raw issue object", async () => {
    const { code_challenge_method: omittedChallengeMethod, ...queryWithoutChallengeMethod } = validQuery;
    void omittedChallengeMethod;
    const response = await request(buildApp(buildConfig())).get("/authorize").query(queryWithoutChallengeMethod);
    // Asserting the whole body (not just error_description) means a sibling key carrying the raw
    // issue — e.g. a `debug` field — would fail this too, not just a corrupted error_description.
    expect(response.body).toEqual({
      error: "invalid_request",
      error_description: "code_challenge_method must be S256",
    });
  });

  it("returns a generic 500 without a stack trace when the client store fails", async () => {
    const config = buildConfig({ logger: silentLogger });
    vi.spyOn(config.storage, "findClient").mockRejectedValue(
      new Error("storage unavailable: connection to db.internal.example refused")
    );
    const response = await request(buildApp(config))
      .get("/authorize")
      // A plain (non-CIMD) client_id, so this exercises the storage.findClient branch directly
      // rather than routing through resolveCimdClient's own error handling.
      .query({ ...validQuery, client_id: "registered-client-id" });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "server_error", error_description: "An unexpected error occurred" });
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain("db.internal.example");
    expect(raw).not.toContain(API_SECRET_CANARY);
    expect(raw).not.toContain(STATE_SECRET);
  });
});
