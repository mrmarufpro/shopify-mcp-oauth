import { describe, expect, it, vi } from "vitest";
import { memoryCache } from "./adapters/memoryCache";
import { memoryStorage } from "./adapters/memoryStorage";
import { RECOMMENDED_RATE_LIMIT, resolveConfig, type ShopifyMcpOAuthConfig } from "./config";

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

  // Rate limiting is opt-in. `null` is the signal buildRouter reads to mount no limiter layer at
  // all, so it has to stay distinguishable from a setting -- resolving an omitted field to some
  // default object instead would silently re-arm both endpoints for every consumer.
  it("leaves the rate limit off when it is not configured", () => {
    expect(resolveConfig(buildConfig()).rateLimit).toBeNull();
  });

  it("resolves an explicit false to the same null as omitting the field", () => {
    expect(resolveConfig(buildConfig({ rateLimit: false })).rateLimit).toBeNull();
  });

  it("publishes a recommended setting consumers can opt in with", () => {
    // The README points consumers at this constant rather than at a pair of numbers, so it is the
    // one place the recommendation lives.
    expect(RECOMMENDED_RATE_LIMIT).toEqual({ limit: 20, windowMs: 3_600_000 });
    expect(resolveConfig(buildConfig({ rateLimit: RECOMMENDED_RATE_LIMIT })).rateLimit).toEqual(RECOMMENDED_RATE_LIMIT);
  });

  it("keeps an explicit rate limit", () => {
    const fiveRequestsPerThirtySeconds = { limit: 5, windowMs: 30_000 };
    expect(resolveConfig(buildConfig({ rateLimit: fiveRequestsPerThirtySeconds })).rateLimit).toEqual(
      fiveRequestsPerThirtySeconds
    );
  });

  it("rejects a rate-limit window too long for setInterval, naming the field", () => {
    // The factory rejects this too, but only once buildRouter reaches it -- and then the message
    // names createRateLimiter rather than the config field the consumer actually wrote.
    expect(() => resolveConfig(buildConfig({ rateLimit: { limit: 20, windowMs: 2 ** 31 } }))).toThrow(/rateLimit/);
  });

  it("rejects a store that does not implement the express-rate-limit Store interface", () => {
    // zod strips `store` rather than rejecting it, so without an explicit check this reaches
    // express-rate-limit and throws "An invalid store was passed", naming no config field at all.
    const aRedisClientRatherThanAStore = { connect: () => {}, sendCommand: () => {} };
    expect(() =>
      resolveConfig(
        buildConfig({ rateLimit: { limit: 20, windowMs: 60_000, store: aRedisClientRatherThanAStore as never } })
      )
    ).toThrow(/rateLimit\.store/);
  });

  it("freezes the recommended setting so one mutation cannot re-tune every limiter built from it", () => {
    // resolveConfig stores whichever object it is handed, by reference. Mutating this shared
    // constant would otherwise reach every handle constructed afterwards in the same process.
    expect(Object.isFrozen(RECOMMENDED_RATE_LIMIT)).toBe(true);
  });

  it("carries a supplied keyFor through to the resolved setting", () => {
    const keyByTenantHeader = (req: { headers: Record<string, string> }) => req.headers["x-tenant"]!;
    const resolved = resolveConfig(
      buildConfig({ rateLimit: { limit: 1, windowMs: 1000, keyFor: keyByTenantHeader as never } })
    );
    expect(resolved.rateLimit?.keyFor).toBe(keyByTenantHeader);
  });

  it("carries a supplied store through to the resolved setting", () => {
    // zod strips unknown keys, so resolving from the parsed copy rather than the raw input would
    // drop this silently -- and a dropped store means each instance quietly counts on its own.
    const sharedStore = {
      increment: async () => ({ totalHits: 1, resetTime: new Date() }),
      decrement: async () => {},
      resetKey: async () => {},
    };
    const resolved = resolveConfig(buildConfig({ rateLimit: { limit: 1, windowMs: 1000, store: sharedStore } }));
    expect(resolved.rateLimit?.store).toBe(sharedStore);
  });

  // Unlike the rate limit above, this cap is not opt-in — every deployment gets it, so the number
  // has to be pinned here rather than left to whatever resolveConfig happens to fill in.
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
    resolveConfig(buildConfig({ logger: { info: vi.fn(), warn, error: vi.fn() }, rateLimit: false }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("single-process"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("redisCache"));
  });

  it("does not claim the fallback cache holds rate-limit counters -- the limiter carries its own store", () => {
    // The rate limiter (rateLimit.ts) never touches `cache` at all -- counting is
    // express-rate-limit's, in its own store, independent of whichever CacheStore resolveConfig
    // picks. An earlier version of this warning said otherwise; this pins the correction.
    const warn = vi.fn();
    resolveConfig(buildConfig({ logger: { info: vi.fn(), warn, error: vi.fn() }, rateLimit: false }));
    expect(warn).toHaveBeenCalledTimes(1);
    const warningMessage = warn.mock.calls[0]![0];
    expect(warningMessage).not.toContain("rate-limit counters");
    expect(warningMessage).toContain("rateLimit");
  });

  it("does not warn when a cache is supplied", () => {
    const warn = vi.fn();
    resolveConfig(
      buildConfig({
        logger: { info: vi.fn(), warn, error: vi.fn() },
        cache: memoryCache(),
        rateLimit: false,
      })
    );
    expect(warn).not.toHaveBeenCalled();
  });

  describe("the opt-in rate limit warning", () => {
    function resolveWithWarnSpy(overrides: Partial<ShopifyMcpOAuthConfig>) {
      const warn = vi.fn();
      resolveConfig(
        buildConfig({ logger: { info: vi.fn(), warn, error: vi.fn() }, cache: memoryCache(), ...overrides })
      );
      return warn;
    }

    it("names the field and both endpoints it would cover when no rate limit is configured", () => {
      // The out-of-the-box deployment leaves two unauthenticated endpoints uncapped. That is the
      // documented default, but a consumer should meet it in their logs at boot rather than in an
      // incident, so this is the one thing resolveConfig says about it.
      const warn = resolveWithWarnSpy({});
      expect(warn).toHaveBeenCalledTimes(1);
      const warningMessage = warn.mock.calls[0]![0] as string;
      expect(warningMessage).toContain("rateLimit");
      expect(warningMessage).toContain("/register");
      expect(warningMessage).toContain("/revoke");
    });

    it("stays quiet once a limit is configured", () => {
      expect(resolveWithWarnSpy({ rateLimit: RECOMMENDED_RATE_LIMIT })).not.toHaveBeenCalled();
    });

    it("stays quiet when the limiter is explicitly declined with false", () => {
      // `false` and omission resolve identically; only the warning tells them apart. That is the
      // whole reason `false` is accepted -- an omitted field reads as "never considered", `false`
      // reads as "considered, declined", and re-warning about the latter on every boot trains
      // consumers to ignore the warning that matters.
      expect(resolveWithWarnSpy({ rateLimit: false })).not.toHaveBeenCalled();
    });
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
