import { describe, expect, it, vi } from "vitest";
import { memoryCache } from "./adapters/memoryCache";
import { memoryStorage } from "./adapters/memoryStorage";
import { resolveConfig, type ShopifyMcpOAuthConfig } from "./config";

const HOST = "https://mcp.example.com";
const STATE_SECRET = "test-state-secret-at-least-32-bytes-long";

function buildConfig(overrides: Partial<ShopifyMcpOAuthConfig> = {}): ShopifyMcpOAuthConfig {
  return {
    host: HOST,
    shopify: { apiKey: "test-api-key", apiSecret: "test-api-secret", scopes: "read_products" },
    stateSecret: STATE_SECRET,
    storage: memoryStorage(),
    ...overrides,
  };
}

describe("resolveConfig", () => {
  it("derives the canonical resource identifier from the host", () => {
    expect(resolveConfig(buildConfig({ host: HOST })).resource).toBe(`${HOST}/mcp`);
  });

  it("strips a trailing slash from the host", () => {
    expect(resolveConfig(buildConfig({ host: `${HOST}/` })).host).toBe(HOST);
  });

  it("defaults the access token TTL to one hour", () => {
    expect(resolveConfig(buildConfig()).tokenTtl.access).toBe(3600);
  });

  it("defaults the refresh token TTL to thirty days", () => {
    expect(resolveConfig(buildConfig()).tokenTtl.refresh).toBe(2_592_000);
  });

  it("keeps an explicit access TTL", () => {
    expect(resolveConfig(buildConfig({ tokenTtl: { access: 900 } })).tokenTtl.access).toBe(900);
  });

  it("defaults the register rate limit to 20 per hour", () => {
    expect(resolveConfig(buildConfig()).registerRateLimit).toEqual({ limit: 20, windowMs: 3_600_000 });
  });

  it("supplies a memory cache when none is given", () => {
    expect(resolveConfig(buildConfig()).cache).toBeDefined();
  });

  it("rejects a host that is not an absolute URL", () => {
    expect(() => resolveConfig(buildConfig({ host: "mcp.example.com" }))).toThrow(/host/);
  });

  it("rejects a host with a query string", () => {
    expect(() => resolveConfig(buildConfig({ host: `${HOST}?x=1` }))).toThrow(/host/);
  });

  it("rejects a host with a fragment", () => {
    expect(() => resolveConfig(buildConfig({ host: `${HOST}#frag` }))).toThrow(/host/);
  });

  it("rejects a host with no hostname", () => {
    expect(() => resolveConfig(buildConfig({ host: "https:///" }))).toThrow(/host/);
  });

  it("keeps a base path when deriving the resource", () => {
    expect(resolveConfig(buildConfig({ host: `${HOST}/base` })).resource).toBe(`${HOST}/base/mcp`);
  });

  it("rejects a state secret shorter than 32 characters", () => {
    expect(() => resolveConfig(buildConfig({ stateSecret: "too-short" }))).toThrow(/stateSecret/);
  });

  it("rejects a missing Shopify api secret", () => {
    const config = buildConfig({ shopify: { apiKey: "test-api-key", apiSecret: "", scopes: "read_products" } });
    expect(() => resolveConfig(config)).toThrow(/apiSecret/);
  });

  it("reports every invalid field, not just the first", () => {
    const config = buildConfig({ host: "not-a-host", stateSecret: "too-short" });
    expect(() => resolveConfig(config)).toThrow(/host/);
    expect(() => resolveConfig(config)).toThrow(/stateSecret/);
  });

  it("defaults the openai challenge token to null", () => {
    expect(resolveConfig(buildConfig()).openaiAppsChallengeToken).toBeNull();
  });

  it("warns when no cache is supplied", () => {
    const warn = vi.fn();
    resolveConfig(buildConfig({ logger: { info: vi.fn(), warn, error: vi.fn() } }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("single-process"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("redisCache"));
  });

  it("does not warn when a cache is supplied", () => {
    const warn = vi.fn();
    resolveConfig(buildConfig({ logger: { info: vi.fn(), warn, error: vi.fn() }, cache: memoryCache() }));
    expect(warn).not.toHaveBeenCalled();
  });
});
