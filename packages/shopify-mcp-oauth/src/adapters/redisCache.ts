import type { CacheStore } from "../types";

interface RedisCommandsLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts: { EX: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/** The chainable command queue `client.multi()` returns — only the two commands this adapter needs. */
export interface RedisMultiLike {
  get(key: string): RedisMultiLike;
  del(key: string): RedisMultiLike;
  /** Replies in the order the commands were queued, so `[0]` is the GET's. */
  exec(): Promise<unknown[]>;
}

/**
 * Shaped after node-redis v4: `getDel` casing, `set(key, value, { EX })`.
 *
 * An atomic read-and-delete is required, not optional — a get-then-del is not a valid substitute,
 * because two concurrent redemptions of one authorization code could both read it before either
 * delete lands, making the code replayable. Two commands provide one, and this adapter prefers
 * `multi()`:
 *
 * - `multi()` — a queued transaction. Redis runs a MULTI/EXEC block to completion without
 *   interleaving another client's commands, so a queued GET+DEL is atomic in exactly the sense this
 *   needs. MULTI has existed in every Redis version, which is why it is the default.
 * - `getDel` — the GETDEL command. Used only when the client exposes no `multi()`.
 *
 * The preference matters because a client library defining `getDel` says nothing about whether the
 * *server* implements GETDEL, which arrived only in Redis 6.2: node-redis v4 exposes the method
 * against any connection, so on a 6.0/6.1 server calling it fails at runtime with `ERR unknown
 * command 'GETDEL'`. That surfaces at authorization-code redemption — on every login — after a boot
 * that looked perfectly healthy. There is no client-side check that can tell the two apart, so the
 * universally available command wins by default.
 *
 * A client with neither doesn't typecheck, and is rejected at construction for JavaScript callers.
 */
export type RedisLikeClient = RedisCommandsLike &
  ({ getDel(key: string): Promise<string | null> } | { multi(): RedisMultiLike });

type MaybeAtomic = RedisCommandsLike & {
  getDel?: (key: string) => Promise<string | null>;
  multi?: () => RedisMultiLike;
};

export function redisCache(client: RedisLikeClient): CacheStore {
  const capable = client as MaybeAtomic;
  const nativeGetDel = capable.getDel;
  const multi = capable.multi;

  // Checked once, at wiring time. Deferring it to the first getdel() call would surface a
  // misconfigured client as `client.multi is not a function` mid-login in production, with
  // nothing in the message naming what to do about it.
  if (typeof multi !== "function" && typeof nativeGetDel !== "function") {
    throw new Error(
      "shopify-mcp-oauth: redisCache needs a client with multi() for a queued GET+DEL, or failing " +
        "that a getDel (GETDEL, Redis >= 6.2). Authorization codes are single-use, which requires " +
        "an atomic read-and-delete; a separate get() then del() is not a valid substitute."
    );
  }

  const getdel =
    typeof multi === "function"
      ? async (key: string) => {
          // Both commands queued before exec() — awaiting a GET and then issuing a DEL would be
          // the non-atomic shape this exists to avoid. exec() replies in queue order.
          const [value] = await multi.call(client).get(key).del(key).exec();
          return (value as string | null) ?? null;
        }
      : (key: string) => nativeGetDel!.call(client, key);

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
    getdel,
  };
}
