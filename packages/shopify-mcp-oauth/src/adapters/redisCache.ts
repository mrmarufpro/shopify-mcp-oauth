import type { CacheStore } from "../types";

export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts: { EX: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
  getDel?(key: string): Promise<string | null>;
}

export function redisCache(client: RedisLikeClient): CacheStore {
  return {
    async get(key) {
      return client.get(key);
    },
    async set(key, value, ttlSeconds) {
      await client.set(key, value, { EX: ttlSeconds });
    },
    async del(key) {
      await client.del(key);
    },
    async getdel(key) {
      // This branches on client capability, not server version: a client that exposes getDel
      // against a pre-6.2 Redis surfaces the server's error rather than falling back. The
      // fallback itself is not atomic — two concurrent redemptions of one authorization code
      // could both read it before either delete lands.
      if (client.getDel) return client.getDel(key);
      const value = await client.get(key);
      await client.del(key);
      return value;
    },
  };
}
