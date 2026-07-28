import { describe, expect, it } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig, type ResolvedConfig } from "../config";
import { serializeAuthorizationServerMetadata, serializeProtectedResourceMetadata } from "./metadata";

const HOST = "https://mcp.example.com";

function buildConfig(): ResolvedConfig {
  return resolveConfig({
    host: HOST,
    shopify: { apiKey: "test-api-key", apiSecret: "test-api-secret", scopes: "read_products" },
    stateSecret: "test-state-secret-at-least-32-bytes-long",
    storage: memoryStorage(),
  });
}

describe("serializeAuthorizationServerMetadata", () => {
  it("advertises the issuer as the host", () => {
    expect(serializeAuthorizationServerMetadata(buildConfig()).issuer).toBe(HOST);
  });

  it("advertises every endpoint under the host", () => {
    const metadata = serializeAuthorizationServerMetadata(buildConfig());
    expect(metadata.authorization_endpoint).toBe(`${HOST}/authorize`);
    expect(metadata.token_endpoint).toBe(`${HOST}/token`);
    expect(metadata.registration_endpoint).toBe(`${HOST}/register`);
    expect(metadata.revocation_endpoint).toBe(`${HOST}/revoke`);
  });

  it("advertises S256 as the only challenge method", () => {
    expect(serializeAuthorizationServerMetadata(buildConfig()).code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("advertises none as the revocation endpoint auth method, since every client is public", () => {
    // RFC 8414 §2 defaults this field to client_secret_basic when absent — omitting it would tell
    // a spec-following client that /revoke needs HTTP Basic auth, which it never checks.
    expect(serializeAuthorizationServerMetadata(buildConfig()).revocation_endpoint_auth_methods_supported).toEqual([
      "none",
    ]);
  });

  it("declares CIMD support so clients skip registration", () => {
    expect(serializeAuthorizationServerMetadata(buildConfig()).client_id_metadata_document_supported).toBe(true);
  });
});

describe("serializeProtectedResourceMetadata", () => {
  it("names the canonical resource", () => {
    expect(serializeProtectedResourceMetadata(buildConfig()).resource).toBe(`${HOST}/mcp`);
  });

  it("points back at this server as its authorization server", () => {
    expect(serializeProtectedResourceMetadata(buildConfig()).authorization_servers).toEqual([HOST]);
  });
});
