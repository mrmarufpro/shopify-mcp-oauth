import { describe, expect, it } from "vitest";
import { authorizeQuerySchema } from "./authorize";
import { cimdDocumentSchema } from "./cimd";
import { registerRequestSchema } from "./register";
import { shopifyCallbackQuerySchema } from "./shopifyCallback";
import { tokenRequestSchema } from "./token";

const CLIENT_ID = "https://client.example/metadata.json";
const REDIRECT_URI = "https://client.example/callback";
const DEMO_SHOP = "demo.myshopify.com";

const validAuthorizeQuery = {
  response_type: "code",
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  state: "client-state",
  code_challenge: "challenge",
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
      code_verifier: "the-verifier",
    });
    expect(result.success).toBe(true);
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
});
