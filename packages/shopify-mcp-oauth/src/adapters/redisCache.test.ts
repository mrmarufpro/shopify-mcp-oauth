import { describe, expect, it, vi } from "vitest";
import { runCacheContractTests } from "../testing/cacheContract";
import { redisCache, type RedisLikeClient, type RedisMultiLike } from "./redisCache";

const KEY = "mcp:oauth:code:abc";

// The override parameter is typed, not `Record<string, unknown>`: these cases turn on exactly which
// of `getDel` / `multi` the fake exposes, so a typo in an override key (`getDell`, `mutli`) would
// silently leave the base client's canned `getDel` in place and have the MULTI tests assert against
// the fallback path -- passing for the wrong reason, on the very tests that guard the atomicity
// claim. Naming the two optional capabilities here makes that a compile error instead.
type FakeRedisOverrides = Partial<{
  get: RedisLikeClient["get"];
  set: RedisLikeClient["set"];
  del: RedisLikeClient["del"];
  getDel: ((key: string) => Promise<string | null>) | undefined;
  multi: (() => RedisMultiLike) | undefined;
}>;

function buildFakeRedis(overrides: FakeRedisOverrides = {}): RedisLikeClient {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    getDel: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as RedisLikeClient;
}

// Backed by a real map with EX semantics, unlike buildFakeRedis's canned responses — the shared
// cache contract needs a client whose state actually mutates across calls, and whose getDel is
// genuinely atomic, to exercise get/set/del/ttl/exclusivity meaningfully.
//
// `capabilities` picks which atomic read-and-delete the fake offers, so the same store can stand in
// for a Redis ≥6.2 server (native GETDEL) and for a 6.0/6.1 one (MULTI only). Both must satisfy the
// identical contract — that equivalence is the whole reason the MULTI fallback is allowed to exist.
function buildStatefulFakeRedis(capabilities: "getDel" | "multi" | "both" = "both"): RedisLikeClient {
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

  const base = {
    async get(key: string) {
      return read(key);
    },
    async set(key: string, value: string, opts: { EX: number }) {
      // Mirrors real Redis's "ERR invalid expire time in 'set' command" — a fake that's more
      // permissive than production here would let the contract's rejection clause pass for the
      // wrong reason.
      if (opts.EX <= 0) throw new Error("ERR invalid expire time in 'set' command");
      entries.set(key, { value, expiresAt: Date.now() + opts.EX * 1000 });
    },
    async del(key: string) {
      entries.delete(key);
    },
  };

  const getDel = async (key: string) => {
    const value = read(key);
    entries.delete(key);
    return value;
  };

  // Queues commands and runs them together on exec(), exactly like a real MULTI: nothing else
  // touches `entries` between the queued GET and the queued DEL, because exec() never awaits in
  // between. A fake that ran each command eagerly would make the exclusivity contract pass for a
  // reason the real client wouldn't reproduce.
  const multi = (): RedisMultiLike => {
    const queued: Array<() => unknown> = [];
    const chain: RedisMultiLike = {
      get(key: string) {
        queued.push(() => read(key));
        return chain;
      },
      del(key: string) {
        queued.push(() => entries.delete(key));
        return chain;
      },
      async exec() {
        return queued.map((run) => run());
      },
    };
    return chain;
  };

  if (capabilities === "getDel") return { ...base, getDel };
  if (capabilities === "multi") return { ...base, multi };
  return { ...base, getDel, multi };
}

describe("redisCache on a client with a native getDel (Redis >= 6.2)", () => {
  runCacheContractTests(() => redisCache(buildStatefulFakeRedis("getDel")));
});

// Redis added GETDEL in 6.2. A server on 6.0/6.1 (still common in managed fleets) has no such
// command, and this adapter used to reject such a client at the type level — sending every one of
// those users off to hand-write a CacheStore. MULTI GET+DEL is atomic in exactly the sense the
// contract requires (Redis runs a queued transaction to completion without interleaving another
// client's commands), so it is a real substitute rather than a weakened one.
describe("redisCache on a client with only MULTI (Redis 6.0/6.1)", () => {
  runCacheContractTests(() => redisCache(buildStatefulFakeRedis("multi")));
});

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

  it("falls back to the client's getDel when it exposes no multi", async () => {
    const getDel = vi.fn().mockResolvedValue("stored-value");
    const client = buildFakeRedis({ getDel, multi: undefined });
    expect(await redisCache(client).getdel(KEY)).toBe("stored-value");
    expect(getDel).toHaveBeenCalledWith(KEY);
  });

  // A client library defining getDel says nothing about whether the SERVER implements GETDEL:
  // node-redis v4 exposes the method against any connection, so on Redis 6.0/6.1 calling it fails
  // at runtime with `ERR unknown command 'GETDEL'` -- at authorization-code redemption, i.e. on
  // every login, having looked perfectly healthy at boot. MULTI has existed in every Redis version
  // and is atomic in exactly the same sense, so it is the safe default and getDel is the fallback,
  // not the other way round. (Found by running this adapter against a real Redis 6.0.)
  it("prefers MULTI over the client's getDel, which may name a command the server lacks", async () => {
    const getDel = vi.fn().mockResolvedValue("from-getdel");
    const chain = { get: vi.fn(), del: vi.fn(), exec: vi.fn().mockResolvedValue(["from-multi", 1]) };
    chain.get.mockReturnValue(chain);
    chain.del.mockReturnValue(chain);
    const client = buildFakeRedis({ getDel, multi: () => chain });

    expect(await redisCache(client).getdel(KEY)).toBe("from-multi");
    expect(getDel).not.toHaveBeenCalled();
  });

  it("uses a queued MULTI GET+DEL", async () => {
    const exec = vi.fn().mockResolvedValue(["stored-value", 1]);
    const chain = { get: vi.fn(), del: vi.fn(), exec };
    chain.get.mockReturnValue(chain);
    chain.del.mockReturnValue(chain);
    const client = buildFakeRedis({ getDel: undefined, multi: () => chain });

    expect(await redisCache(client).getdel(KEY)).toBe("stored-value");
    // Both commands must be queued on the same transaction — a GET awaited before the DEL is
    // queued is the non-atomic shape this fallback exists to avoid.
    expect(chain.get).toHaveBeenCalledWith(KEY);
    expect(chain.del).toHaveBeenCalledWith(KEY);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("reads null from a MULTI whose GET found nothing", async () => {
    const chain = { get: vi.fn(), del: vi.fn(), exec: vi.fn().mockResolvedValue([null, 0]) };
    chain.get.mockReturnValue(chain);
    chain.del.mockReturnValue(chain);
    const client = buildFakeRedis({ getDel: undefined, multi: () => chain });

    expect(await redisCache(client).getdel(KEY)).toBeNull();
  });

  // The types below reject this, but a JavaScript consumer (or one who cast) reaches it — and the
  // failure it would otherwise produce is `client.getDel is not a function` on the first login
  // attempt, in production, long after construction. Fail at wiring time with the reason instead.
  it("throws at construction when the client offers neither getDel nor multi", () => {
    const client = { get: vi.fn(), set: vi.fn(), del: vi.fn() } as unknown as RedisLikeClient;
    expect(() => redisCache(client)).toThrow(/getDel.*multi|multi.*getDel/i);
  });
});

// Type-only regression guard: a client offering neither a native getDel nor multi must not satisfy
// RedisLikeClient. Both are atomic read-and-delete; a plain get-then-del is not, which would make a
// redeemed authorization code replayable under concurrent requests. Declared but never called;
// exists solely for `pnpm typecheck` to catch a regression if that requirement is ever loosened.
function clientWithNeitherAtomicReadAndDeleteIsRejected(): void {
  const clientMissingBoth = {
    get: async () => null,
    set: async () => undefined,
    del: async () => undefined,
  };
  // @ts-expect-error one of getDel / multi is required — a client with neither is not atomic
  const client: RedisLikeClient = clientMissingBoth;
  void client;
}
void clientWithNeitherAtomicReadAndDeleteIsRejected;
