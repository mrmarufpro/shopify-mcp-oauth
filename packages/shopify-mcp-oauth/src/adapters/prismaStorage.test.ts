import { describe, expect, it, vi } from "vitest";
import { prismaStorage, type PrismaLikeClient } from "./prismaStorage";
import type { NewOAuthClient, NewToken } from "../types";

const DEMO_SHOP = "demo.myshopify.com";
const CLIENT_ID = "prisma-client-id";
const TOKEN_ID = "token-1";
const LAST_USED_AT = new Date("2026-01-15T12:00:00.000Z");

function buildPrisma(overrides: Record<string, unknown> = {}): PrismaLikeClient {
  return {
    mcpOAuthClient: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(null),
    },
    mcpOAuthToken: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    ...overrides,
  } as unknown as PrismaLikeClient;
}

describe("prismaStorage", () => {
  it("maps a client row into the OAuthClient shape", async () => {
    const prisma = buildPrisma({
      mcpOAuthClient: {
        findFirst: vi.fn().mockResolvedValue({
          clientId: CLIENT_ID,
          clientName: "Prisma Client",
          redirectUris: ["https://client.example/callback"],
          grantTypes: ["authorization_code"],
          responseTypes: ["code"],
          logoUri: null,
          clientUri: null,
          tokenEndpointAuthMethod: "none",
          revokedAt: null,
        }),
        create: vi.fn(),
        upsert: vi.fn(),
      },
    });
    const found = await prismaStorage(prisma).findClient(CLIENT_ID);
    expect(found?.clientName).toBe("Prisma Client");
  });

  it("passes client fields through to create and maps the returned row back", async () => {
    const newClient: NewOAuthClient = {
      clientId: CLIENT_ID,
      clientName: "Created Client",
      redirectUris: ["https://created.example/callback"],
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      logoUri: null,
      clientUri: null,
      tokenEndpointAuthMethod: "none",
    };
    const create = vi.fn().mockResolvedValue({ ...newClient, revokedAt: null });
    const prisma = buildPrisma({
      mcpOAuthClient: { findFirst: vi.fn(), create, upsert: vi.fn() },
    });
    const created = await prismaStorage(prisma).createClient(newClient);
    expect(create).toHaveBeenCalledWith({ data: newClient });
    expect(created.clientId).toBe(CLIENT_ID);
  });

  it("upsertClient sends an empty update, matching insert-if-absent semantics", async () => {
    const newClient: NewOAuthClient = {
      clientId: CLIENT_ID,
      clientName: "Upserted Client",
      redirectUris: ["https://client.example/callback"],
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      logoUri: null,
      clientUri: null,
      tokenEndpointAuthMethod: "none",
    };
    const upsert = vi.fn().mockResolvedValue({ ...newClient, revokedAt: null });
    const prisma = buildPrisma({
      mcpOAuthClient: { findFirst: vi.fn(), create: vi.fn(), upsert },
    });
    await prismaStorage(prisma).upsertClient(newClient);
    const call = upsert.mock.calls[0]?.[0];
    expect(call.where).toEqual({ clientId: CLIENT_ID });
    expect(call.update).toEqual({});
  });

  it("passes token fields through to create and maps the returned row back", async () => {
    const newToken: NewToken = {
      shopId: "shop_1",
      shopDomain: DEMO_SHOP,
      clientId: CLIENT_ID,
      accessTokenHash: "access-hash-created",
      refreshTokenHash: "refresh-hash-created",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
      scope: "mcp:*",
      resource: "https://mcp.example.com/mcp",
      rotatedFromId: null,
    };
    const create = vi.fn().mockResolvedValue({ ...newToken, id: "token-row-1", revokedAt: null });
    const prisma = buildPrisma({
      mcpOAuthToken: { findFirst: vi.fn(), create, updateMany: vi.fn() },
    });
    const created = await prismaStorage(prisma).createToken(newToken);
    expect(create).toHaveBeenCalledWith({ data: newToken });
    expect(created.clientId).toBe(CLIENT_ID);
  });

  it("filters expired and revoked rows in the access-hash lookup", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = buildPrisma({
      mcpOAuthToken: { findFirst, create: vi.fn(), updateMany: vi.fn() },
    });
    await prismaStorage(prisma).findTokenByAccessHash("some-hash");
    const where = findFirst.mock.calls[0]?.[0]?.where;
    expect(where.accessTokenHash).toBe("some-hash");
    expect(where.revokedAt).toBeNull();
    expect(where.accessTokenExpiresAt.gt).toBeInstanceOf(Date);
  });

  it("ignores expiry but still filters revoked rows in the revocation access-hash lookup", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = buildPrisma({
      mcpOAuthToken: { findFirst, create: vi.fn(), updateMany: vi.fn() },
    });
    await prismaStorage(prisma).findTokenByAccessHashIgnoringExpiry("some-hash");
    const where = findFirst.mock.calls[0]?.[0]?.where;
    expect(where.accessTokenHash).toBe("some-hash");
    expect(where.revokedAt).toBeNull();
    expect(where.accessTokenExpiresAt).toBeUndefined();
  });

  it("filters expired and revoked rows in the refresh-hash lookup", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = buildPrisma({
      mcpOAuthToken: { findFirst, create: vi.fn(), updateMany: vi.fn() },
    });
    await prismaStorage(prisma).findTokenByRefreshHash("some-refresh-hash");
    const where = findFirst.mock.calls[0]?.[0]?.where;
    expect(where.refreshTokenHash).toBe("some-refresh-hash");
    expect(where.revokedAt).toBeNull();
    expect(where.refreshTokenExpiresAt.gt).toBeInstanceOf(Date);
  });

  it("revokeToken reports false when no unrevoked row matched", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = buildPrisma({
      mcpOAuthToken: { findFirst: vi.fn(), create: vi.fn(), updateMany },
    });
    expect(await prismaStorage(prisma).revokeToken(TOKEN_ID)).toBe(false);
    expect(updateMany.mock.calls[0]?.[0]?.where).toEqual({ id: TOKEN_ID, revokedAt: null });
  });

  it("revokeToken reports true when one row flipped", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = buildPrisma({
      mcpOAuthToken: { findFirst: vi.fn(), create: vi.fn(), updateMany },
    });
    expect(await prismaStorage(prisma).revokeToken(TOKEN_ID)).toBe(true);
    const call = updateMany.mock.calls[0]?.[0];
    expect(call.where).toEqual({ id: TOKEN_ID, revokedAt: null });
    expect(call.data.revokedAt).toBeInstanceOf(Date);
  });

  it("touchToken does not throw when the delegate has no updateMany", async () => {
    const prisma = buildPrisma({
      mcpOAuthToken: { findFirst: vi.fn(), create: vi.fn(), updateMany: undefined },
    });
    await expect(prismaStorage(prisma).touchToken(TOKEN_ID, new Date())).resolves.toBeUndefined();
  });

  it("touchToken sends the id and lastUsedAt to updateMany", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = buildPrisma({
      mcpOAuthToken: { findFirst: vi.fn(), create: vi.fn(), updateMany },
    });
    await prismaStorage(prisma).touchToken(TOKEN_ID, LAST_USED_AT);
    const call = updateMany.mock.calls[0]?.[0];
    expect(call.where).toEqual({ id: TOKEN_ID });
    expect(call.data.lastUsedAt).toBe(LAST_USED_AT);
  });

  it("looks the shop up through the configured mapping", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "store_7", myshopifyDomain: DEMO_SHOP });
    const prisma = buildPrisma({ store: { findFirst } });
    const storage = prismaStorage(prisma, {
      shop: { model: "store", domainField: "myshopifyDomain", idField: "id" },
    });
    expect(await storage.findShopByDomain(DEMO_SHOP)).toEqual({ id: "store_7", domain: DEMO_SHOP });
    expect(findFirst).toHaveBeenCalledWith({ where: { myshopifyDomain: DEMO_SHOP } });
  });

  it("returns null when the mapped shop row is absent", async () => {
    const prisma = buildPrisma({ store: { findFirst: vi.fn().mockResolvedValue(null) } });
    const storage = prismaStorage(prisma, {
      shop: { model: "store", domainField: "myshopifyDomain", idField: "id" },
    });
    expect(await storage.findShopByDomain(DEMO_SHOP)).toBeNull();
  });
});

// Type-only regression guard: `prismaStorage` without a shop mapping must not expose
// `findShopByDomain`. Declared but never called — it exists solely for `pnpm typecheck` to catch a
// regression in the overload. If the overload's enforcement is ever lost, the line below stops
// producing a real error and typecheck fails on "Unused '@ts-expect-error' directive."
function unmappedStorageHasNoShopLookup(prisma: PrismaLikeClient): void {
  const storageWithoutShopMapping = prismaStorage(prisma);
  // @ts-expect-error findShopByDomain is intentionally absent without a shop mapping
  const lookup = storageWithoutShopMapping.findShopByDomain;
  void lookup;
}
void unmappedStorageHasNoShopLookup;
