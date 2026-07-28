import { describe, expect, it, vi } from "vitest";
import { prismaStorage, type PrismaLikeClient } from "./prismaStorage";

const DEMO_SHOP = "demo.myshopify.com";
const CLIENT_ID = "prisma-client-id";

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

  it("revokeToken reports false when no unrevoked row matched", async () => {
    const prisma = buildPrisma({
      mcpOAuthToken: {
        findFirst: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });
    expect(await prismaStorage(prisma).revokeToken("token-1")).toBe(false);
  });

  it("revokeToken reports true when one row flipped", async () => {
    const prisma = buildPrisma({
      mcpOAuthToken: {
        findFirst: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    });
    expect(await prismaStorage(prisma).revokeToken("token-1")).toBe(true);
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
