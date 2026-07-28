import { describe, expect, it } from "vitest";
import { runCacheContractTests } from "../testing/cacheContract";
import { memoryCache } from "./memoryCache";

const KEY = "mcp:oauth:code:abc";

runCacheContractTests(() => memoryCache());

describe("memoryCache", () => {
  it("returns null for a key it never stored", async () => {
    expect(await memoryCache().get(KEY)).toBeNull();
  });

  it("returns a stored value", async () => {
    const cache = memoryCache();
    await cache.set(KEY, "stored-value", 60);
    expect(await cache.get(KEY)).toBe("stored-value");
  });

  it("expires a value once its TTL has passed", async () => {
    const cache = memoryCache();
    await cache.set(KEY, "stored-value", -1);
    expect(await cache.get(KEY)).toBeNull();
  });

  it("deletes a value", async () => {
    const cache = memoryCache();
    await cache.set(KEY, "stored-value", 60);
    await cache.del(KEY);
    expect(await cache.get(KEY)).toBeNull();
  });

  it("reads and deletes atomically via getdel", async () => {
    const cache = memoryCache();
    await cache.set(KEY, "stored-value", 60);
    expect(await cache.getdel(KEY)).toBe("stored-value");
    expect(await cache.get(KEY)).toBeNull();
  });
});
