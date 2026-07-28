import { describe, expect, it } from "vitest";
import { authorizeQuerySchema } from "./authorize";
import { CIMD_MAX_REDIRECT_URIS, cimdDocumentSchema } from "./cimd";
import { REGISTER_MAX_REDIRECT_URIS, registerRequestSchema } from "./register";
import { revokeRequestSchema } from "./revoke";
import { shopifyCallbackQuerySchema } from "./shopifyCallback";
import { tokenRequestSchema } from "./token";

const CLIENT_ID = "https://client.example/metadata.json";
const REDIRECT_URI = "https://client.example/callback";
const DEMO_SHOP = "demo.myshopify.com";
// RFC 7636 Appendix B.1 test vector (same pair used in crypto.test.ts): a real verifier/challenge
// so the length- and charset-sensitive fields below accept a genuinely conformant client.
const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const validAuthorizeQuery = {
  response_type: "code",
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  state: "client-state",
  code_challenge: CODE_CHALLENGE,
  code_challenge_method: "S256",
};

describe("authorizeQuerySchema", () => {
  it("accepts a complete query", () => {
    expect(authorizeQuerySchema.safeParse(validAuthorizeQuery).success).toBe(true);
  });

  it("rejects a plain code_challenge_method", () => {
    const result = authorizeQuerySchema.safeParse({ ...validAuthorizeQuery, code_challenge_method: "plain" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing code_challenge, so PKCE cannot be skipped", () => {
    const { code_challenge, ...withoutChallenge } = validAuthorizeQuery;
    expect(authorizeQuerySchema.safeParse(withoutChallenge).success).toBe(false);
  });

  it("rejects a missing code_challenge_method, so it cannot default to plain", () => {
    const { code_challenge_method, ...withoutMethod } = validAuthorizeQuery;
    expect(authorizeQuerySchema.safeParse(withoutMethod).success).toBe(false);
  });

  it("rejects a code_challenge with an invalid length", () => {
    const result = authorizeQuerySchema.safeParse({ ...validAuthorizeQuery, code_challenge: "too-short" });
    expect(result.success).toBe(false);
  });

  it("treats resource as optional", () => {
    const parsed = authorizeQuerySchema.parse(validAuthorizeQuery);
    expect(parsed.resource).toBeUndefined();
  });
});

describe("tokenRequestSchema", () => {
  it("accepts an authorization_code grant", () => {
    const result = tokenRequestSchema.safeParse({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: CODE_VERIFIER,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a code_verifier shorter than the RFC 7636 minimum", () => {
    const result = tokenRequestSchema.safeParse({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: "too-short",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an authorization_code grant with no code_verifier", () => {
    const result = tokenRequestSchema.safeParse({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
    });
    expect(result.success).toBe(false);
  });

  it("accepts a refresh_token grant", () => {
    const result = tokenRequestSchema.safeParse({
      grant_type: "refresh_token",
      refresh_token: "the-refresh-token",
      client_id: CLIENT_ID,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown grant_type", () => {
    expect(tokenRequestSchema.safeParse({ grant_type: "password" }).success).toBe(false);
  });

  it("rejects a missing grant_type, even when every other authorization_code field is present", () => {
    const result = tokenRequestSchema.safeParse({
      code: "the-code",
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: CODE_VERIFIER,
    });
    expect(result.success).toBe(false);
  });
});

describe("registerRequestSchema", () => {
  it("accepts a minimal registration", () => {
    expect(registerRequestSchema.safeParse({ redirect_uris: [REDIRECT_URI] }).success).toBe(true);
  });

  it("rejects an empty redirect_uris array", () => {
    expect(registerRequestSchema.safeParse({ redirect_uris: [] }).success).toBe(false);
  });

  it("rejects a javascript: redirect_uri", () => {
    expect(registerRequestSchema.safeParse({ redirect_uris: ["javascript:alert(1)"] }).success).toBe(false);
  });

  it("accepts a registration at the redirect_uris cap", () => {
    const redirectUrisAtCap = Array.from(
      { length: REGISTER_MAX_REDIRECT_URIS },
      (_, index) => `https://client.example/callback/${index}`
    );
    expect(registerRequestSchema.safeParse({ redirect_uris: redirectUrisAtCap }).success).toBe(true);
  });

  it("rejects a registration exceeding the redirect_uris cap", () => {
    const redirectUrisOverCap = Array.from(
      { length: REGISTER_MAX_REDIRECT_URIS + 1 },
      (_, index) => `https://client.example/callback/${index}`
    );
    expect(registerRequestSchema.safeParse({ redirect_uris: redirectUrisOverCap }).success).toBe(false);
  });
});

describe("shopifyCallbackQuerySchema", () => {
  it("accepts a well-formed callback", () => {
    const result = shopifyCallbackQuerySchema.safeParse({
      shop: DEMO_SHOP,
      code: "shopify-code",
      state: "state-jwt",
      hmac: "hmac-value",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a shop domain outside myshopify.com", () => {
    const result = shopifyCallbackQuerySchema.safeParse({
      shop: "attacker.example.com",
      code: "shopify-code",
      state: "state-jwt",
      hmac: "hmac-value",
    });
    expect(result.success).toBe(false);
  });
});

describe("revokeRequestSchema", () => {
  it("accepts a minimal revoke request", () => {
    expect(revokeRequestSchema.safeParse({ token: "the-token" }).success).toBe(true);
  });

  it("rejects an unknown token_type_hint without echoing the submitted value", () => {
    const TOKEN_TYPE_HINT_VALUE = "shpat_should-not-appear-in-error";
    const result = revokeRequestSchema.safeParse({ token: "the-token", token_type_hint: TOKEN_TYPE_HINT_VALUE });

    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((issue) => issue.message).join(" ");
      expect(message).not.toContain(TOKEN_TYPE_HINT_VALUE);
    }
  });
});

describe("cimdDocumentSchema", () => {
  it("accepts a document with redirect_uris", () => {
    expect(cimdDocumentSchema.safeParse({ redirect_uris: [REDIRECT_URI] }).success).toBe(true);
  });

  it("rejects a document with no redirect_uris", () => {
    expect(cimdDocumentSchema.safeParse({ client_name: "Client" }).success).toBe(false);
  });

  it("rejects grant_types that omit authorization_code", () => {
    const result = cimdDocumentSchema.safeParse({
      redirect_uris: [REDIRECT_URI],
      grant_types: ["client_credentials"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a token_endpoint_auth_method other than none", () => {
    const result = cimdDocumentSchema.safeParse({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "client_secret_post",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a document at the redirect_uris cap", () => {
    const redirectUrisAtCap = Array.from(
      { length: CIMD_MAX_REDIRECT_URIS },
      (_, index) => `https://client.example/callback/${index}`
    );
    expect(cimdDocumentSchema.safeParse({ redirect_uris: redirectUrisAtCap }).success).toBe(true);
  });

  it("rejects a document exceeding the redirect_uris cap", () => {
    const redirectUrisOverCap = Array.from(
      { length: CIMD_MAX_REDIRECT_URIS + 1 },
      (_, index) => `https://client.example/callback/${index}`
    );
    expect(cimdDocumentSchema.safeParse({ redirect_uris: redirectUrisOverCap }).success).toBe(false);
  });
});
