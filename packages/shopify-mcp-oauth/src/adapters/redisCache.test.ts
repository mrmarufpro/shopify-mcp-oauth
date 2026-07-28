import { describe, expect, it, vi } from "vitest";
import { runCacheContractTests } from "../testing/cacheContract";
import { redisCache, type RedisLikeClient } from "./redisCache";

const KEY = "mcp:oauth:code:abc";
const CONCURRENT_REDEMPTIONS = 5;

function buildFakeRedis(overrides: Partial<RedisLikeClient> = {}): RedisLikeClient {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

// Backed by a real map with EX semantics, unlike buildFakeRedis's canned responses — the shared
// cache contract needs a client whose state actually mutates across calls, and whose getDel is
// genuinely atomic, to exercise get/set/del/ttl/exclusivity meaningfully.
function buildStatefulFakeRedis(): RedisLikeClient {
  const entries = new Map<string, { value: string; expiresAt: number }>();

  function read(key: string): string | null {
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      entries.delete(key);
      return null;
    }
    return entry.value;
  }

  return {
    async get(key) {
      return read(key);
    },
    async set(key, value, opts) {
      entries.set(key, { value, expiresAt: Date.now() + opts.EX * 1000 });
    },
    async del(key) {
      entries.delete(key);
    },
    async getDel(key) {
      const value = read(key);
      entries.delete(key);
      return value;
    },
  };
}

runCacheContractTests(() => redisCache(buildStatefulFakeRedis()));

describe("redisCache", () => {
  it("sets with an EX ttl", async () => {
    const client = buildFakeRedis();
    await redisCache(client).set(KEY, "stored-value", 60);
    expect(client.set).toHaveBeenCalledWith(KEY, "stored-value", { EX: 60 });
  });

  it("reads a stored value", async () => {
    const client = buildFakeRedis({ get: vi.fn().mockResolvedValue("stored-value") });
    expect(await redisCache(client).get(KEY)).toBe("stored-value");
  });

  it("uses getDel when the client supports it", async () => {
    const getDel = vi.fn().mockResolvedValue("stored-value");
    const client = buildFakeRedis({ getDel });
    expect(await redisCache(client).getdel(KEY)).toBe("stored-value");
    expect(getDel).toHaveBeenCalledWith(KEY);
  });

  it("falls back to get then del when getDel is absent", async () => {
    const client = buildFakeRedis({ get: vi.fn().mockResolvedValue("stored-value") });
    expect(await redisCache(client).getdel(KEY)).toBe("stored-value");
    expect(client.del).toHaveBeenCalledWith(KEY);
  });

  // Documents a known, currently-accepted gap rather than a guarantee: when the underlying
  // Redis client doesn't expose a native getDel, the get+del fallback is two round trips with
  // no lock between them, so concurrent callers can all read before any of them deletes. Every
  // caller here "wins" — the exact failure mode CacheStore.getdel's atomicity contract exists
  // to rule out. Flagged in the Task 13 review; left as-is pending a decision on how to close it.
  it("KNOWN LIMITATION: the get+del fallback is not exclusive under concurrent calls", async () => {
    const client = buildFakeRedis({ get: vi.fn().mockResolvedValue("stored-value") });
    const cache = redisCache(client);
    const results = await Promise.all(Array.from({ length: CONCURRENT_REDEMPTIONS }, () => cache.getdel(KEY)));
    expect(results.filter((result) => result !== null)).toHaveLength(CONCURRENT_REDEMPTIONS);
  });
});
