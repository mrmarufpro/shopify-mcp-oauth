import { describe, expect, it, vi } from "vitest";
import { memoryCache } from "./adapters/memoryCache";
import { memoryStorage } from "./adapters/memoryStorage";
import { resolveConfig, type ShopifyMcpOAuthConfig } from "./config";

const HOST = "https://mcp.example.com";
const STATE_SECRET = "test-state-secret-at-least-32-bytes-long";

// Silent by default so the no-cache warning does not spray stderr across every case that isn't
// about it. The two tests that assert the warning pass their own spy logger.
const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function buildConfig(overrides: Partial<ShopifyMcpOAuthConfig> = {}): ShopifyMcpOAuthConfig {
  return {
    host: HOST,
    shopify: { apiKey: "test-api-key", apiSecret: "test-api-secret", scopes: "read_products" },
    stateSecret: STATE_SECRET,
    storage: memoryStorage(),
    logger: silentLogger,
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

  it("defaults the revoke rate limit to 20 per hour", () => {
    expect(resolveConfig(buildConfig()).revokeRateLimit).toEqual({ limit: 20, windowMs: 3_600_000 });
  });

  it("keeps an explicit revoke rate limit instead of the default", () => {
    const revokeRateLimit = { limit: 5, windowMs: 30_000 };
    expect(resolveConfig(buildConfig({ revokeRateLimit })).revokeRateLimit).toEqual(revokeRateLimit);
  });

  it("keeps registerRateLimit and revokeRateLimit independently tunable", () => {
    const resolved = resolveConfig(
      buildConfig({ registerRateLimit: { limit: 1, windowMs: 1000 }, revokeRateLimit: { limit: 2, windowMs: 2000 } })
    );
    expect(resolved.registerRateLimit).toEqual({ limit: 1, windowMs: 1000 });
    expect(resolved.revokeRateLimit).toEqual({ limit: 2, windowMs: 2000 });
  });

  // A default nothing pins is exactly how rateLimit.ts's own maxEntries default nearly shipped
  // unbounded — this is that lesson applied here, not a hypothetical.
  it("defaults the CIMD fetch concurrency cap to 10", () => {
    expect(resolveConfig(buildConfig()).cimdFetchConcurrency).toBe(10);
  });

  it("keeps an explicit cimdFetchConcurrency instead of the default", () => {
    expect(resolveConfig(buildConfig({ cimdFetchConcurrency: 3 })).cimdFetchConcurrency).toBe(3);
  });

  it("builds a cimdFetchLimiter from the resolved cimdFetchConcurrency", async () => {
    // Not just "a limiter exists" — it must actually enforce the configured number, not some
    // other hardcoded value. See services/cimd.test.ts for the request-level version of this same
    // proof, driven through resolveCimdClient rather than the limiter's own run() directly.
    const resolved = resolveConfig(buildConfig({ cimdFetchConcurrency: 1 }));
    const started = new Set<string>();
    function buildTask(name: string): { task: () => Promise<void>; release: () => void } {
      let releaseFn: (() => void) | undefined;
      return {
        task: () => {
          started.add(name);
          return new Promise<void>((resolve) => {
            releaseFn = resolve;
          });
        },
        release: () => releaseFn?.(),
      };
    }
    const first = buildTask("first");
    const second = buildTask("second");

    const results = Promise.all([
      resolved.cimdFetchLimiter.run(first.task),
      resolved.cimdFetchLimiter.run(second.task),
    ]);
    await vi.waitFor(() => expect(started.has("first")).toBe(true));
    expect(started.has("second")).toBe(false);

    first.release();
    await vi.waitFor(() => expect(started.has("second")).toBe(true));
    second.release();
    await results;
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

  it("rejects a host with a username and password", () => {
    expect(() => resolveConfig(buildConfig({ host: "https://user:pass@mcp.example.com" }))).toThrow(/host/);
  });

  it("rejects a host with just a username", () => {
    expect(() => resolveConfig(buildConfig({ host: "https://attacker@mcp.example.com" }))).toThrow(/host/);
  });

  it("keeps a base path when deriving the resource", () => {
    expect(resolveConfig(buildConfig({ host: `${HOST}/base` })).resource).toBe(`${HOST}/base/mcp`);
  });

  it("lowercases an uppercase host", () => {
    expect(resolveConfig(buildConfig({ host: "HTTPS://MCP.EXAMPLE.COM" })).resource).toBe(`${HOST}/mcp`);
  });

  it("drops an explicit default port", () => {
    expect(resolveConfig(buildConfig({ host: `${HOST}:443` })).resource).toBe(`${HOST}/mcp`);
  });

  it("produces a single slash before mcp for a plain host with no path", () => {
    const resolved = resolveConfig(buildConfig({ host: HOST }));
    expect(resolved.host).toBe(HOST);
    expect(resolved.resource).toBe(`${HOST}/mcp`);
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

  it("does not claim the fallback cache holds rate-limit counters -- those are process-local, not cached", () => {
    // The /register rate limiter (rateLimit.ts) never touches `cache` at all -- it's an
    // in-process Map, independent of whichever CacheStore resolveConfig picks. An earlier
    // version of this warning said otherwise; this pins the correction.
    const warn = vi.fn();
    resolveConfig(buildConfig({ logger: { info: vi.fn(), warn, error: vi.fn() } }));
    expect(warn).toHaveBeenCalledTimes(1);
    const warningMessage = warn.mock.calls[0]![0];
    expect(warningMessage).not.toContain("rate-limit counters");
    expect(warningMessage).toContain("registerRateLimit");
    expect(warningMessage).toContain("revokeRateLimit");
  });

  it("does not warn when a cache is supplied", () => {
    const warn = vi.fn();
    resolveConfig(buildConfig({ logger: { info: vi.fn(), warn, error: vi.fn() }, cache: memoryCache() }));
    expect(warn).not.toHaveBeenCalled();
  });
});

// Symmetric with redisCache's construction-time client check: a JavaScript caller who passes the
// wrong thing here otherwise boots clean and fails as `config.onShopNotFound is not a function`
// inside the Shopify callback -- a 500 during a real merchant's login, naming nothing actionable.
describe("resolveConfig validates onShopNotFound", () => {
  it("rejects a non-function onShopNotFound at construction time", () => {
    expect(() =>
      resolveConfig(
        buildConfig({ onShopNotFound: { domain: "x" } as unknown as ShopifyMcpOAuthConfig["onShopNotFound"] })
      )
    ).toThrow(/onShopNotFound/);
  });

  it("accepts an omitted onShopNotFound and resolves it to null", () => {
    expect(resolveConfig(buildConfig()).onShopNotFound).toBeNull();
  });

  it("keeps a real handler as-is", () => {
    const handler = vi.fn().mockResolvedValue(null);
    expect(resolveConfig(buildConfig({ onShopNotFound: handler })).onShopNotFound).toBe(handler);
  });
});
