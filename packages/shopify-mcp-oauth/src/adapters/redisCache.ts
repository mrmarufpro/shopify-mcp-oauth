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
      // GETDEL needs Redis 6.2+. Older servers fall back to GET then DEL, which is not atomic;
      // a concurrent redemption of the same authorization code could read it twice.
      if (client.getDel) return client.getDel(key);
      const value = await client.get(key);
      await client.del(key);
      return value;
    },
  };
}
