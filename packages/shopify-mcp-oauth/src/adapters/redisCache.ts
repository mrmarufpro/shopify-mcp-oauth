import type { CacheStore } from "../types";

/**
 * Shaped after node-redis v4: `getDel` casing, `set(key, value, { EX })`. `getDel` is required,
 * not optional — this adapter needs node-redis ≥4 talking to Redis ≥6.2 (the GETDEL command it
 * wraps), because a get-then-del fallback is not atomic: two concurrent redemptions of one
 * authorization code could both read it before either delete lands, making the code replayable.
 * Requiring it here narrows compatibility no further than this interface already does.
 */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts: { EX: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
  getDel(key: string): Promise<string | null>;
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
      return client.getDel(key);
    },
  };
}
