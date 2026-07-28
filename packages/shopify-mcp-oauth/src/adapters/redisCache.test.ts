import { describe, expect, it, vi } from "vitest";
import { redisCache, type RedisLikeClient } from "./redisCache";

const KEY = "mcp:oauth:code:abc";

function buildFakeRedis(overrides: Partial<RedisLikeClient> = {}): RedisLikeClient {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

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
    expect(await redisCache(client).getdel?.(KEY)).toBe("stored-value");
    expect(getDel).toHaveBeenCalledWith(KEY);
  });

  it("falls back to get then del when getDel is absent", async () => {
    const client = buildFakeRedis({ get: vi.fn().mockResolvedValue("stored-value") });
    expect(await redisCache(client).getdel?.(KEY)).toBe("stored-value");
    expect(client.del).toHaveBeenCalledWith(KEY);
  });
});
