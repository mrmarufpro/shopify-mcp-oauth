import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig, type ResolvedConfig } from "../config";
import { sha256Base64Url } from "../crypto";
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
// RFC 7636 Appendix B.1 test vector (same pair used in crypto.test.ts / schemas.test.ts), with the
// challenge derived via this package's own sha256Base64Url rather than a hand-typed placeholder —
// so a later full-flow test (Task 21) can redeem a code using this exact verifier.
const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CODE_CHALLENGE = sha256Base64Url(CODE_VERIFIER);

// Only the "generic 500" test needs this — it deliberately triggers asyncHandler's error log,
// and the default console logger would print a stack trace on every full-suite run otherwise.
const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function buildConfig(overrides: { logger?: Logger; fetchImpl?: typeof fetch } = {}): ResolvedConfig {
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

// No options object at all -- the shape a real deployment mounts the controller with. Exists
// specifically to prove the SSRF guard is actually on by default; every other test in this file
// uses buildApp above, which opts into the private-host escape hatch for test convenience.
function buildAppWithDefaultCimdHosts(config: ResolvedConfig) {
  const app = express();
  app.get("/authorize", authorizeController(config));
  return app;
}

// supertest/superagent types response.headers as a plain string-keyed record, so
// noUncheckedIndexedAccess widens response.headers.location to string | undefined even though a
// 302 always sets it — every caller here already depends on that redirect having happened.
function redirectLocation(response: request.Response): string {
  return response.headers.location ?? "";
}

function extractOuterState(response: request.Response) {
  const redirectParam = new URL(redirectLocation(response)).searchParams.get("redirect") ?? "";
  const stateJwt = new URLSearchParams(redirectParam.split("?")[1]).get("state") ?? "";
  return verifyOuterState(stateJwt, STATE_SECRET);
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
    // All 7 outerStatePayloadSchema fields, not a subset: codeChallengeMethod in particular is a
    // PKCE-downgrade guard (S256-only is a binding constraint Tasks 16/17 rely on), and resource
    // is what ties the eventual token back to this specific audience.
    const response = await request(buildApp(buildConfig())).get("/authorize").query(validQuery);
    const verified = extractOuterState(response);
    expect(verified.clientId).toBe(CIMD_URL);
    expect(verified.redirectUri).toBe(REDIRECT_URI);
    expect(verified.clientState).toBe(CLIENT_STATE);
    expect(verified.codeChallenge).toBe(CODE_CHALLENGE);
    expect(verified.codeChallengeMethod).toBe("S256");
    expect(verified.resource).toBe(`${HOST}/mcp`);
    expect(verified.nonce.length).toBeGreaterThan(0);
  });

  it("signs a fresh nonce on every authorize call", async () => {
    const firstResponse = await request(buildApp(buildConfig())).get("/authorize").query(validQuery);
    const secondResponse = await request(buildApp(buildConfig())).get("/authorize").query(validQuery);
    expect(extractOuterState(firstResponse).nonce).not.toBe(extractOuterState(secondResponse).nonce);
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

  it("returns a generic 500 without leaking internal detail when CIMD resolution's storage lookup fails", async () => {
    // resolveCimdClient checks storage before the network (see services/cimd.ts), so a CIMD
    // client_id still reaches config.storage.findClient. That lookup is deliberately unguarded
    // inside resolveCimdClient — a storage outage is an infrastructure failure, not a statement
    // about the client's own document, and must reach asyncHandler's generic 500 rather than
    // being reflected into a 400 body as (error as Error).message would have done.
    const config = buildConfig({ logger: silentLogger });
    vi.spyOn(config.storage, "findClient").mockRejectedValue(
      new Error("storage unavailable: connection to db.internal.example refused")
    );
    const response = await request(buildApp(config)).get("/authorize").query(validQuery);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "server_error", error_description: "An unexpected error occurred" });
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain("db.internal.example");
    expect(raw).not.toContain(API_SECRET_CANARY);
    expect(raw).not.toContain(STATE_SECRET);
  });

  it("rejects a client whose CIMD document is genuinely invalid, naming the reason", async () => {
    const invalidDocumentResponse = new Response(JSON.stringify({ client_name: "Invalid Client", redirect_uris: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const config = buildConfig({
      fetchImpl: vi.fn().mockResolvedValue(invalidDocumentResponse) as unknown as typeof fetch,
    });
    const response = await request(buildApp(config)).get("/authorize").query(validQuery);
    // Exact match, not a substring/regex check: bad(res, error.description, error.code) must not
    // double up the OAuthError's own "invalid_client: " message prefix on top of error.code.
    expect(response.body).toEqual({
      error: "invalid_client",
      error_description: "redirect_uris: CIMD document missing redirect_uris[]",
    });
    expect(response.status).toBe(400);
  });

  it("returns 400, not 500, when the CIMD host is unreachable, and does not log a stack trace", async () => {
    const errorSpy = vi.fn();
    const config = buildConfig({
      logger: { info: () => {}, warn: () => {}, error: errorSpy },
      fetchImpl: vi.fn().mockRejectedValue(new TypeError("fetch failed")) as unknown as typeof fetch,
    });
    const response = await request(buildApp(config)).get("/authorize").query(validQuery);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_client");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("returns 400, not 500, for a malformed client_id URL, and does not log a stack trace", async () => {
    const errorSpy = vi.fn();
    const config = buildConfig({ logger: { info: () => {}, warn: () => {}, error: errorSpy } });
    const response = await request(buildApp(config))
      .get("/authorize")
      .query({ ...validQuery, client_id: "https://[" });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_client");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("rejects a private-host CIMD client_id when allowPrivateCimdHosts is not set (the production default)", async () => {
    // buildAppWithDefaultCimdHosts, not buildApp -- proving the SSRF guard is actually on unless a
    // caller opts out, not merely that it CAN reject a private host when told to.
    const response = await request(buildAppWithDefaultCimdHosts(buildConfig()))
      .get("/authorize")
      .query({ ...validQuery, client_id: "https://127.0.0.1/metadata.json" });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_client");
  });

  it("never embeds a secret in the bounce URL, and pins the picker's shape", async () => {
    const response = await request(buildApp(buildConfig())).get("/authorize").query(validQuery);
    const location = redirectLocation(response);
    expect(location).not.toContain(API_SECRET_CANARY);
    expect(location).not.toContain(STATE_SECRET);
    const shopPickerUrl = new URL(location);
    expect(shopPickerUrl.host).toBe("admin.shopify.com");
    expect(shopPickerUrl.searchParams.get("no_redirect")).toBe("true");
  });
});
