import { describe, expect, it } from "vitest";
import { authorizeQuerySchema } from "./authorize";
import {
  CIMD_MAX_CLIENT_NAME_LENGTH,
  CIMD_MAX_GRANT_TYPES,
  CIMD_MAX_REDIRECT_URIS,
  CIMD_MAX_RESPONSE_TYPES,
  CIMD_MAX_URI_LENGTH,
  cimdDocumentSchema,
} from "./cimd";
import {
  REGISTER_MAX_CLIENT_NAME_LENGTH,
  REGISTER_MAX_GRANT_TYPES,
  REGISTER_MAX_REDIRECT_URIS,
  REGISTER_MAX_RESPONSE_TYPES,
  REGISTER_MAX_URI_LENGTH,
  registerRequestSchema,
} from "./register";
import { revokeRequestSchema } from "./revoke";
import { shopifyCallbackQuerySchema } from "./shopifyCallback";
import { tokenRequestSchema } from "./token";

const CLIENT_ID = "https://client.example/metadata.json";
const REDIRECT_URI = "https://client.example/callback";
const DEMO_SHOP = "example.myshopify.com";
// RFC 7636 Appendix B.1 test vector (same pair used in crypto.test.ts): a real verifier/challenge
// so the length- and charset-sensitive fields below accept a genuinely conformant client.
const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function buildUriOfExactLength(length: number): string {
  const prefix = "https://client.example/";
  return (prefix + "a".repeat(length - prefix.length)).slice(0, length);
}

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

  it("accepts a redirect_uris entry at the length cap", () => {
    const uriAtLengthCap = buildUriOfExactLength(REGISTER_MAX_URI_LENGTH);
    expect(registerRequestSchema.safeParse({ redirect_uris: [uriAtLengthCap] }).success).toBe(true);
  });

  it("rejects a redirect_uris entry exceeding the length cap", () => {
    const uriOverLengthCap = buildUriOfExactLength(REGISTER_MAX_URI_LENGTH + 1);
    expect(registerRequestSchema.safeParse({ redirect_uris: [uriOverLengthCap] }).success).toBe(false);
  });

  it("accepts a client_name at the length cap", () => {
    const clientNameAtCap = "a".repeat(REGISTER_MAX_CLIENT_NAME_LENGTH);
    expect(
      registerRequestSchema.safeParse({ redirect_uris: [REDIRECT_URI], client_name: clientNameAtCap }).success
    ).toBe(true);
  });

  it("rejects a client_name exceeding the length cap", () => {
    const clientNameOverCap = "a".repeat(REGISTER_MAX_CLIENT_NAME_LENGTH + 1);
    expect(
      registerRequestSchema.safeParse({ redirect_uris: [REDIRECT_URI], client_name: clientNameOverCap }).success
    ).toBe(false);
  });

  it("accepts grant_types at the cap", () => {
    const grantTypesAtCap = Array.from({ length: REGISTER_MAX_GRANT_TYPES }, (_, index) => `grant-${index}`);
    expect(
      registerRequestSchema.safeParse({ redirect_uris: [REDIRECT_URI], grant_types: grantTypesAtCap }).success
    ).toBe(true);
  });

  it("rejects grant_types exceeding the cap", () => {
    const grantTypesOverCap = Array.from({ length: REGISTER_MAX_GRANT_TYPES + 1 }, (_, index) => `grant-${index}`);
    expect(
      registerRequestSchema.safeParse({ redirect_uris: [REDIRECT_URI], grant_types: grantTypesOverCap }).success
    ).toBe(false);
  });

  it("accepts response_types at the cap", () => {
    const responseTypesAtCap = Array.from({ length: REGISTER_MAX_RESPONSE_TYPES }, (_, index) => `type-${index}`);
    expect(
      registerRequestSchema.safeParse({ redirect_uris: [REDIRECT_URI], response_types: responseTypesAtCap }).success
    ).toBe(true);
  });

  it("rejects response_types exceeding the cap", () => {
    const responseTypesOverCap = Array.from({ length: REGISTER_MAX_RESPONSE_TYPES + 1 }, (_, index) => `type-${index}`);
    expect(
      registerRequestSchema.safeParse({ redirect_uris: [REDIRECT_URI], response_types: responseTypesOverCap }).success
    ).toBe(false);
  });

  it("treats an absent grant_types as valid and leaves it undefined", () => {
    const result = registerRequestSchema.parse({ redirect_uris: [REDIRECT_URI] });
    expect(result.grant_types).toBeUndefined();
  });

  it("treats an absent response_types as valid and leaves it undefined", () => {
    const result = registerRequestSchema.parse({ redirect_uris: [REDIRECT_URI] });
    expect(result.response_types).toBeUndefined();
  });

  it("accepts a logo_uri at the length cap", () => {
    const logoUriAtCap = buildUriOfExactLength(REGISTER_MAX_URI_LENGTH);
    expect(registerRequestSchema.safeParse({ redirect_uris: [REDIRECT_URI], logo_uri: logoUriAtCap }).success).toBe(
      true
    );
  });

  it("rejects a logo_uri exceeding the length cap", () => {
    const logoUriOverCap = buildUriOfExactLength(REGISTER_MAX_URI_LENGTH + 1);
    expect(registerRequestSchema.safeParse({ redirect_uris: [REDIRECT_URI], logo_uri: logoUriOverCap }).success).toBe(
      false
    );
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
      // The message alone isn't enough — zod's own enum issue carries `received` regardless of a
      // custom message, so any consumer that serializes the whole issue (logging, an API error
      // body) would still leak the value. Assert it's absent from the full serialized issue too.
      expect(JSON.stringify(result.error.issues)).not.toContain(TOKEN_TYPE_HINT_VALUE);
    }
  });

  it("preserves the narrowed token_type_hint literal type", () => {
    const result = revokeRequestSchema.parse({ token: "the-token", token_type_hint: "refresh_token" });
    // A type error here (not just a runtime one) would mean the pipe widened token_type_hint back
    // to a plain string, losing the exhaustiveness a controller relies on when comparing against it.
    const hint: "access_token" | "refresh_token" | undefined = result.token_type_hint;
    expect(hint).toBe("refresh_token");
  });
});

describe("cimdDocumentSchema", () => {
  it("accepts a document with redirect_uris", () => {
    expect(cimdDocumentSchema.safeParse({ redirect_uris: [REDIRECT_URI] }).success).toBe(true);
  });

  it("rejects a document with no redirect_uris", () => {
    expect(cimdDocumentSchema.safeParse({ client_name: "Client" }).success).toBe(false);
  });

  it("rejects a javascript: redirect_uri", () => {
    expect(cimdDocumentSchema.safeParse({ redirect_uris: ["javascript:alert(1)"] }).success).toBe(false);
  });

  it("rejects a cleartext http redirect_uri on a non-loopback host", () => {
    // The concrete exploit this closes: a CIMD document declaring an http:// redirect_uri would
    // otherwise be accepted here even though the byte-identical DCR registration is rejected by
    // registerRequestSchema's own validateRedirectUri refine, letting the authorization code be
    // delivered over cleartext HTTP.
    const result = cimdDocumentSchema.safeParse({ redirect_uris: ["http://attacker.example/cb"] });
    expect(result.success).toBe(false);
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

  it("accepts a redirect_uris entry at the length cap", () => {
    const uriAtLengthCap = buildUriOfExactLength(CIMD_MAX_URI_LENGTH);
    expect(cimdDocumentSchema.safeParse({ redirect_uris: [uriAtLengthCap] }).success).toBe(true);
  });

  it("rejects a redirect_uris entry exceeding the length cap", () => {
    const uriOverLengthCap = buildUriOfExactLength(CIMD_MAX_URI_LENGTH + 1);
    expect(cimdDocumentSchema.safeParse({ redirect_uris: [uriOverLengthCap] }).success).toBe(false);
  });

  it("accepts a client_name at the length cap", () => {
    const clientNameAtCap = "a".repeat(CIMD_MAX_CLIENT_NAME_LENGTH);
    expect(cimdDocumentSchema.safeParse({ redirect_uris: [REDIRECT_URI], client_name: clientNameAtCap }).success).toBe(
      true
    );
  });

  it("rejects a client_name exceeding the length cap", () => {
    const clientNameOverCap = "a".repeat(CIMD_MAX_CLIENT_NAME_LENGTH + 1);
    expect(
      cimdDocumentSchema.safeParse({ redirect_uris: [REDIRECT_URI], client_name: clientNameOverCap }).success
    ).toBe(false);
  });

  it("accepts grant_types at the cap, including authorization_code", () => {
    const grantTypesAtCap = [
      "authorization_code",
      ...Array.from({ length: CIMD_MAX_GRANT_TYPES - 1 }, (_, index) => `grant-${index}`),
    ];
    expect(cimdDocumentSchema.safeParse({ redirect_uris: [REDIRECT_URI], grant_types: grantTypesAtCap }).success).toBe(
      true
    );
  });

  it("rejects grant_types exceeding the cap", () => {
    const grantTypesOverCap = [
      "authorization_code",
      ...Array.from({ length: CIMD_MAX_GRANT_TYPES }, (_, index) => `grant-${index}`),
    ];
    expect(
      cimdDocumentSchema.safeParse({ redirect_uris: [REDIRECT_URI], grant_types: grantTypesOverCap }).success
    ).toBe(false);
  });

  it("accepts response_types at the cap", () => {
    const responseTypesAtCap = Array.from({ length: CIMD_MAX_RESPONSE_TYPES }, (_, index) => `type-${index}`);
    expect(
      cimdDocumentSchema.safeParse({ redirect_uris: [REDIRECT_URI], response_types: responseTypesAtCap }).success
    ).toBe(true);
  });

  it("rejects response_types exceeding the cap", () => {
    const responseTypesOverCap = Array.from({ length: CIMD_MAX_RESPONSE_TYPES + 1 }, (_, index) => `type-${index}`);
    expect(
      cimdDocumentSchema.safeParse({ redirect_uris: [REDIRECT_URI], response_types: responseTypesOverCap }).success
    ).toBe(false);
  });

  it("treats an absent grant_types as valid and leaves it undefined", () => {
    const result = cimdDocumentSchema.parse({ redirect_uris: [REDIRECT_URI] });
    expect(result.grant_types).toBeUndefined();
  });

  it("treats an absent response_types as valid and leaves it undefined", () => {
    const result = cimdDocumentSchema.parse({ redirect_uris: [REDIRECT_URI] });
    expect(result.response_types).toBeUndefined();
  });

  it("reports only the count issue when grant_types is both over cap and missing authorization_code", () => {
    const grantTypesOverCapWithoutAuthCode = Array.from(
      { length: CIMD_MAX_GRANT_TYPES + 1 },
      (_, index) => `grant-${index}`
    );
    const result = cimdDocumentSchema.safeParse({
      redirect_uris: [REDIRECT_URI],
      grant_types: grantTypesOverCapWithoutAuthCode,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages).toEqual(["CIMD document has too many grant_types"]);
    }
  });

  it("accepts a logo_uri at the length cap", () => {
    const logoUriAtCap = buildUriOfExactLength(CIMD_MAX_URI_LENGTH);
    expect(cimdDocumentSchema.safeParse({ redirect_uris: [REDIRECT_URI], logo_uri: logoUriAtCap }).success).toBe(true);
  });

  it("rejects a logo_uri exceeding the length cap", () => {
    const logoUriOverCap = buildUriOfExactLength(CIMD_MAX_URI_LENGTH + 1);
    expect(cimdDocumentSchema.safeParse({ redirect_uris: [REDIRECT_URI], logo_uri: logoUriOverCap }).success).toBe(
      false
    );
  });
});
