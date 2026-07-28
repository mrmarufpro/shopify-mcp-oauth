import express, { type Request, type Response } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig, type ResolvedConfig } from "../config";
import { sha256Base64Url, sha256Hex } from "../crypto";
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
const LOOPBACK_BOUND_REDIRECT_URI = "http://127.0.0.1:4000/callback";
const LOOPBACK_DIFFERENT_PORT_REDIRECT_URI = "http://127.0.0.1:53219/callback";
const DEFAULT_SCOPE = "mcp:*";
// Deliberately different from config.resource (`${HOST}/mcp`, see resolveConfig): if a check
// dropped `resource: record.resource` and just let issueTokens default to config.resource, using
// the default value here would still pass by coincidence. This constant makes that impossible.
const DISTINCT_RESOURCE = `${HOST}/mcp/reports`;

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

async function issueTestCode(
  config: ResolvedConfig,
  overrides: { redirectUri?: string; resource?: string } = {}
): Promise<string> {
  const { code } = await issueCode(config, {
    shopId: DEMO_SHOP_ID,
    shopDomain: DEMO_SHOP,
    clientId: CLIENT_ID,
    redirectUri: overrides.redirectUri ?? REDIRECT_URI,
    codeChallenge: sha256Base64Url(CODE_VERIFIER),
    codeChallengeMethod: "S256",
    resource: overrides.resource ?? `${HOST}/mcp`,
  });
  return code;
}

// Invokes the controller directly, bypassing Express/supertest's real HTTP transport. Two
// requests sent through supertest never actually race the atomic-getdel window inside
// consumeCode — the transport overhead alone outlasts it, so a non-atomic get+del mutation would
// look "single-use" by accident. Calling the handler function twice back-to-back under
// Promise.all keeps both calls in the same microtask interleaving the real HTTP path can't offer.
function invokeTokenController(
  config: ResolvedConfig,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const handler = tokenController(config);
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const res = {
      headersSent: false,
      set() {
        return res;
      },
      status(code: number) {
        statusCode = code;
        return res;
      },
      json(payload: Record<string, unknown>) {
        resolve({ status: statusCode, body: payload });
      },
    } as unknown as Response;
    handler({ body } as unknown as Request, res, (err?: unknown) => {
      if (err) reject(err);
    });
  });
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
    expect(response.body.scope).toBe(DEFAULT_SCOPE);
  });

  it("binds the issued token to the code's own shop, client, and resource, not a default", async () => {
    // shopId/shopDomain/clientId/resource are copied from the consumed code record onto the
    // issued token (services/tokens.ts's issueTokens + storage.createToken). Looks the stored row
    // up by access-token hash and asserts all four together, so a mutation that forges any single
    // field — or defaults `resource` to config.resource instead of the code's own — gets caught.
    const config = buildConfig();
    const code = await issueTestCode(config, { resource: DISTINCT_RESOURCE });

    const response = await request(buildApp(config)).post("/token").send({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: CODE_VERIFIER,
    });

    expect(response.status).toBe(200);
    const stored = await config.storage.findTokenByAccessHash(sha256Hex(response.body.access_token));
    expect(stored).not.toBeNull();
    expect(stored?.shopId).toBe(DEMO_SHOP_ID);
    expect(stored?.shopDomain).toBe(DEMO_SHOP);
    expect(stored?.clientId).toBe(CLIENT_ID);
    expect(stored?.resource).toBe(DISTINCT_RESOURCE);
  });

  it("lets only one of two concurrent redemptions of the same code win", async () => {
    const config = buildConfig();
    const code = await issueTestCode(config);
    const body = {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: CODE_VERIFIER,
    };

    const [first, second] = await Promise.all([
      invokeTokenController(config, body),
      invokeTokenController(config, body),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 400]);
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
    expect(response.body.error).toBe("invalid_grant");
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
    expect(response.body.error).toBe("invalid_grant");
  });

  it("rejects a loopback redirect_uri whose port differs from the one bound to the code", async () => {
    // The loopback port flexibility of RFC 8252 §7.3 belongs to /authorize, where the presented
    // redirect_uri is matched against the client's *registered* URIs (see redirectUriMatches and
    // its exhaustive coverage in services/redirectUri.test.ts). What's stored on the code is the
    // exact string the client already presented and had accepted at that step, and RFC 6749
    // §4.1.3 requires this leg's redirect_uri be identical to that one — so even a same-host,
    // loopback, different-port value must be rejected here, not waved through.
    const config = buildConfig();
    const response = await request(buildApp(config))
      .post("/token")
      .send({
        grant_type: "authorization_code",
        code: await issueTestCode(config, { redirectUri: LOOPBACK_BOUND_REDIRECT_URI }),
        redirect_uri: LOOPBACK_DIFFERENT_PORT_REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: CODE_VERIFIER,
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_grant");
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

  it("ignores a client-requested scope and returns the token's own stored scope", async () => {
    // refreshTokenGrantSchema accepts an optional `scope`, but rotateRefresh never reads it —
    // only the stored record's own scope carries over. Requesting a wider one here must not
    // widen what comes back.
    const config = buildConfig();
    const first = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    const response = await request(buildApp(config)).post("/token").send({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: CLIENT_ID,
      scope: "admin:* mcp:*",
    });

    expect(response.status).toBe(200);
    expect(response.body.scope).toBe(first.scope);
    expect(response.body.scope).toBe(DEFAULT_SCOPE);
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

  it("reports invalid_request, not unsupported_grant_type, when grant_type itself is missing", async () => {
    // RFC 6749 §5.2: a missing required parameter is invalid_request. unsupported_grant_type is
    // only for a grant_type that was actually presented and just isn't one this server supports.
    const response = await request(buildApp(buildConfig())).post("/token").send({ code: "the-code" });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_request");
  });

  it("reports invalid_request when a known grant is missing a field", async () => {
    const response = await request(buildApp(buildConfig()))
      .post("/token")
      .send({ grant_type: "authorization_code", code: "the-code" });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_request");
  });

  it("never echoes the submitted grant_type value back into the error body", async () => {
    const response = await request(buildApp(buildConfig()))
      .post("/token")
      .send({ grant_type: "<script>alert(1)</script>" });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("unsupported_grant_type");
    expect(JSON.stringify(response.body)).not.toContain("<script>");
  });

  it("marks every /token response, success or error, as not cacheable per RFC 6749 §5.1", async () => {
    const config = buildConfig();
    const successResponse = await request(buildApp(config))
      .post("/token")
      .send({
        grant_type: "authorization_code",
        code: await issueTestCode(config),
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: CODE_VERIFIER,
      });
    expect(successResponse.headers["cache-control"]).toBe("no-store");
    expect(successResponse.headers["pragma"]).toBe("no-cache");

    const errorResponse = await request(buildApp(config)).post("/token").send({ grant_type: "bogus" });
    expect(errorResponse.headers["cache-control"]).toBe("no-store");
    expect(errorResponse.headers["pragma"]).toBe("no-cache");
  });
});
