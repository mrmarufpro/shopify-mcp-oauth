import { describe, expect, it } from "vitest";
import type { CacheStore } from "../types";

const CONTRACT_KEY = "mcp:oauth:contract-key";
const CONTRACT_VALUE = "contract-value";
const CONCURRENT_REDEMPTIONS = 5;

export function runCacheContractTests(makeCache: () => Promise<CacheStore> | CacheStore): void {
  describe("CacheStore contract", () => {
    it("returns null for a key that was never stored", async () => {
      const cache = await makeCache();
      expect(await cache.get(CONTRACT_KEY)).toBeNull();
    });

    it("returns a stored value", async () => {
      const cache = await makeCache();
      await cache.set(CONTRACT_KEY, CONTRACT_VALUE, 60);
      expect(await cache.get(CONTRACT_KEY)).toBe(CONTRACT_VALUE);
    });

    it("returns null once a value's ttl has passed", async () => {
      const cache = await makeCache();
      await cache.set(CONTRACT_KEY, CONTRACT_VALUE, -1);
      expect(await cache.get(CONTRACT_KEY)).toBeNull();
    });

    it("returns null after del", async () => {
      const cache = await makeCache();
      await cache.set(CONTRACT_KEY, CONTRACT_VALUE, 60);
      await cache.del(CONTRACT_KEY);
      expect(await cache.get(CONTRACT_KEY)).toBeNull();
    });

    it("getdel returns null for a key that was never stored", async () => {
      const cache = await makeCache();
      expect(await cache.getdel(CONTRACT_KEY)).toBeNull();
    });

    it("getdel returns the value and removes it in one call", async () => {
      const cache = await makeCache();
      await cache.set(CONTRACT_KEY, CONTRACT_VALUE, 60);
      expect(await cache.getdel(CONTRACT_KEY)).toBe(CONTRACT_VALUE);
      expect(await cache.get(CONTRACT_KEY)).toBeNull();
    });

    // The property the whole package leans on for single-use codes and one-shot refresh rotation:
    // of several callers racing the same key, exactly one may see the value. A get-then-del
    // implementation fails this every time, because every caller's get() runs before any del().
    it("lets only one of several concurrent getdel calls win", async () => {
      const cache = await makeCache();
      await cache.set(CONTRACT_KEY, CONTRACT_VALUE, 60);
      const results = await Promise.all(
        Array.from({ length: CONCURRENT_REDEMPTIONS }, () => cache.getdel(CONTRACT_KEY))
      );
      expect(results.filter((result) => result !== null)).toHaveLength(1);
    });
  });
}
