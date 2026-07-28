import { describe, expect, it } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig, type ResolvedConfig } from "../config";
import { sha256Hex } from "../crypto";
import { consumeCode, issueCode, type CodeRecord } from "./codes";

const DEMO_SHOP = "example.myshopify.com";
const DEMO_SHOP_ID = "shop_1";
const CLIENT_ID = "test-client-id";
const REDIRECT_URI = "https://client.example/callback";
const RESOURCE = "https://mcp.example.com/mcp";

function buildConfig(): ResolvedConfig {
  return resolveConfig({
    host: "https://mcp.example.com",
    shopify: { apiKey: "test-api-key", apiSecret: "test-api-secret", scopes: "read_products" },
    stateSecret: "test-state-secret-at-least-32-bytes-long",
    storage: memoryStorage(),
  });
}

function buildCodeRecord(overrides: Partial<CodeRecord> = {}): CodeRecord {
  return {
    shopId: DEMO_SHOP_ID,
    shopDomain: DEMO_SHOP,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    codeChallenge: "challenge-value",
    codeChallengeMethod: "S256",
    resource: RESOURCE,
    ...overrides,
  };
}

describe("authorization codes", () => {
  it("round-trips the record", async () => {
    const config = buildConfig();
    const record = buildCodeRecord();
    const { code } = await issueCode(config, record);
    expect(await consumeCode(config, code)).toEqual(record);
  });

  it("cannot be consumed twice", async () => {
    const config = buildConfig();
    const { code } = await issueCode(config, buildCodeRecord());
    await consumeCode(config, code);
    expect(await consumeCode(config, code)).toBeNull();
  });

  it("returns null for a code that was never issued", async () => {
    expect(await consumeCode(buildConfig(), "never-issued")).toBeNull();
  });

  it("does not store a code whose ttl has already passed", async () => {
    const config = buildConfig();
    const { code } = await issueCode(config, { ...buildCodeRecord(), ttlSeconds: -1 });
    expect(await consumeCode(config, code)).toBeNull();
  });

  it("stores the code under its hash, not its plaintext", async () => {
    const config = buildConfig();
    const { code } = await issueCode(config, buildCodeRecord());
    expect(await config.cache.get(`mcp:oauth:code:${code}`)).toBeNull();
    expect(await config.cache.get(`mcp:oauth:code:${sha256Hex(code)}`)).not.toBeNull();
  });

  it("returns null instead of throwing for a corrupted cache entry", async () => {
    const config = buildConfig();
    const code = "hand-crafted-code";
    await config.cache.set(`mcp:oauth:code:${sha256Hex(code)}`, "{not valid json", 60);
    await expect(consumeCode(config, code)).resolves.toBeNull();
  });
});
