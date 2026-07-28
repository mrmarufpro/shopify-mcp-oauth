import { describe, expect, it, vi } from "vitest";
import { runCacheContractTests } from "../testing/cacheContract";
import { redisCache, type RedisLikeClient } from "./redisCache";

const KEY = "mcp:oauth:code:abc";

function buildFakeRedis(overrides: Partial<RedisLikeClient> = {}): RedisLikeClient {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    getDel: vi.fn().mockResolvedValue(null),
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

  it("delegates getdel to the client's native getDel", async () => {
    const getDel = vi.fn().mockResolvedValue("stored-value");
    const client = buildFakeRedis({ getDel });
    expect(await redisCache(client).getdel(KEY)).toBe("stored-value");
    expect(getDel).toHaveBeenCalledWith(KEY);
  });
});

// Type-only regression guard: a client without a native getDel must not satisfy RedisLikeClient —
// the get+del fallback that optionality used to permit was not atomic, making a redeemed
// authorization code replayable under concurrent requests. Declared but never called; exists
// solely for `pnpm typecheck` to catch a regression if getDel is ever made optional again.
function clientWithoutGetDelIsRejected(): void {
  const clientMissingGetDel = {
    get: async () => null,
    set: async () => undefined,
    del: async () => undefined,
  };
  // @ts-expect-error getDel is required — a client without it must not satisfy RedisLikeClient
  const client: RedisLikeClient = clientMissingGetDel;
  void client;
}
void clientWithoutGetDelIsRejected;
