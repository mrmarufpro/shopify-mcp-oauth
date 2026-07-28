import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig, type ResolvedConfig } from "../config";
import { sha256Base64Url } from "../crypto";
import { issueCode } from "../services/codes";
import { issueTokens } from "../services/tokens";
import { tokenController } from "./token";

const HOST = "https://mcp.example.com";
const DEMO_SHOP = "demo.myshopify.com";
const DEMO_SHOP_ID = "shop_1";
const CLIENT_ID = "test-client-id";
const REDIRECT_URI = "https://client.example/callback";
const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
// Must still satisfy the 43-128 char code_verifier shape (schemas/token.ts), or it fails schema
// validation before ever reaching the PKCE hash comparison these tests mean to exercise.
const WRONG_CODE_VERIFIER = "not-the-verifier-that-made-the-challenge-xyz";
const LOOPBACK_REGISTERED_REDIRECT_URI = "http://127.0.0.1:4000/callback";
const LOOPBACK_EPHEMERAL_REDIRECT_URI = "http://127.0.0.1:53219/callback";

function buildConfig(): ResolvedConfig {
  return resolveConfig({
    host: HOST,
    shopify: { apiKey: "test-api-key", apiSecret: "test-api-secret", scopes: "read_products" },
    stateSecret: "test-state-secret-at-least-32-bytes-long",
    storage: memoryStorage({ shops: [{ id: DEMO_SHOP_ID, domain: DEMO_SHOP }] }),
  });
}

function buildApp(config: ResolvedConfig) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.post("/token", tokenController(config));
  return app;
}

async function issueTestCode(config: ResolvedConfig, overrides: { redirectUri?: string } = {}): Promise<string> {
  const { code } = await issueCode(config, {
    shopId: DEMO_SHOP_ID,
    shopDomain: DEMO_SHOP,
    clientId: CLIENT_ID,
    redirectUri: overrides.redirectUri ?? REDIRECT_URI,
    codeChallenge: sha256Base64Url(CODE_VERIFIER),
    codeChallengeMethod: "S256",
    resource: `${HOST}/mcp`,
  });
  return code;
}

describe("tokenController — authorization_code", () => {
  it("exchanges a valid code for a token bundle", async () => {
    const config = buildConfig();
    const response = await request(buildApp(config))
      .post("/token")
      .send({
        grant_type: "authorization_code",
        code: await issueTestCode(config),
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: CODE_VERIFIER,
      });

    expect(response.status).toBe(200);
    expect(response.body.token_type).toBe("Bearer");
    expect(response.body.access_token).toBeTruthy();
    expect(response.body.refresh_token).toBeTruthy();
    expect(response.body.expires_in).toBe(3600);
  });

  it("rejects a wrong PKCE verifier", async () => {
    const config = buildConfig();
    const response = await request(buildApp(config))
      .post("/token")
      .send({
        grant_type: "authorization_code",
        code: await issueTestCode(config),
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: WRONG_CODE_VERIFIER,
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_grant");
  });

  it("rejects a code whose stored code_challenge_method is not S256, even when the verifier hashes correctly", async () => {
    // A well-behaved /authorize never stores anything but "S256" (schemas/authorize.ts pins the
    // literal), so this reaches the codes service directly to simulate a record that got here some
    // other way. codeChallenge is deliberately the real S256 hash of CODE_VERIFIER, so a controller
    // that forgets to check the method — and just calls verifyS256 — would wrongly accept this.
    const config = buildConfig();
    const { code } = await issueCode(config, {
      shopId: DEMO_SHOP_ID,
      shopDomain: DEMO_SHOP,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeChallenge: sha256Base64Url(CODE_VERIFIER),
      codeChallengeMethod: "plain",
      resource: `${HOST}/mcp`,
    });

    const response = await request(buildApp(config)).post("/token").send({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: CODE_VERIFIER,
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_grant");
  });

  it("rejects a code presented by a different client", async () => {
    const config = buildConfig();
    const response = await request(buildApp(config))
      .post("/token")
      .send({
        grant_type: "authorization_code",
        code: await issueTestCode(config),
        redirect_uri: REDIRECT_URI,
        client_id: "some-other-client",
        code_verifier: CODE_VERIFIER,
      });

    expect(response.status).toBe(400);
  });

  it("rejects a mismatched redirect_uri", async () => {
    const config = buildConfig();
    const response = await request(buildApp(config))
      .post("/token")
      .send({
        grant_type: "authorization_code",
        code: await issueTestCode(config),
        redirect_uri: "https://attacker.example/callback",
        client_id: CLIENT_ID,
        code_verifier: CODE_VERIFIER,
      });

    expect(response.status).toBe(400);
  });

  it("accepts a loopback redirect_uri whose port differs from the one bound to the code", async () => {
    // RFC 8252 §7.3: a native client's loopback redirect binds an ephemeral port picked when it
    // starts listening, which can legitimately differ between the /authorize and /token legs.
    // redirectUriMatches (already covered exhaustively in services/redirectUri.test.ts) is what
    // grants that flexibility; this test just pins that the controller actually calls it instead
    // of a strict string comparison.
    const config = buildConfig();
    const response = await request(buildApp(config))
      .post("/token")
      .send({
        grant_type: "authorization_code",
        code: await issueTestCode(config, { redirectUri: LOOPBACK_REGISTERED_REDIRECT_URI }),
        redirect_uri: LOOPBACK_EPHEMERAL_REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: CODE_VERIFIER,
      });

    expect(response.status).toBe(200);
  });

  it("refuses to redeem the same code twice", async () => {
    const config = buildConfig();
    const app = buildApp(config);
    const code = await issueTestCode(config);
    const body = {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: CODE_VERIFIER,
    };

    await request(app).post("/token").send(body);
    const second = await request(app).post("/token").send(body);
    expect(second.status).toBe(400);
  });

  it("burns the code on a failed PKCE check, so a later correct verifier can't redeem it", async () => {
    const config = buildConfig();
    const app = buildApp(config);
    const code = await issueTestCode(config);

    const wrongVerifierAttempt = await request(app).post("/token").send({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: WRONG_CODE_VERIFIER,
    });
    expect(wrongVerifierAttempt.status).toBe(400);

    const retryWithCorrectVerifier = await request(app).post("/token").send({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: CODE_VERIFIER,
    });
    expect(retryWithCorrectVerifier.status).toBe(400);
  });

  it("accepts a form-encoded body, which is what most clients send", async () => {
    const config = buildConfig();
    const response = await request(buildApp(config))
      .post("/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code: await issueTestCode(config),
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: CODE_VERIFIER,
      });

    expect(response.status).toBe(200);
  });
});

describe("tokenController — refresh_token", () => {
  it("rotates a valid refresh token", async () => {
    const config = buildConfig();
    const first = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    const response = await request(buildApp(config))
      .post("/token")
      .send({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLIENT_ID });

    expect(response.status).toBe(200);
    expect(response.body.refresh_token).not.toBe(first.refresh_token);
  });

  it("rejects a refresh token that was already rotated", async () => {
    const config = buildConfig();
    const app = buildApp(config);
    const first = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    const body = { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLIENT_ID };

    await request(app).post("/token").send(body);
    const second = await request(app).post("/token").send(body);
    expect(second.status).toBe(400);
  });
});

describe("tokenController — bad requests", () => {
  it("reports unsupported_grant_type for an unknown grant", async () => {
    const response = await request(buildApp(buildConfig()))
      .post("/token")
      .send({ grant_type: "password", username: "merchant" });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("unsupported_grant_type");
  });

  it("reports invalid_request when a known grant is missing a field", async () => {
    const response = await request(buildApp(buildConfig()))
      .post("/token")
      .send({ grant_type: "authorization_code", code: "the-code" });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_request");
  });
});
