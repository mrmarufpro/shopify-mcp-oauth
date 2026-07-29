import { PrismaClient } from "@prisma/client";
import { prismaStorage } from "shopify-mcp-oauth";
import { runStorageContractTests } from "shopify-mcp-oauth/testing";
import { afterAll, describe, it } from "vitest";
import { buildDemoOfflineSession } from "./demoSession";

const DEMO_SHOP = "demo.myshopify.com";

if (!process.env.DATABASE_URL) {
  describe.skip("prismaStorage contract — set DATABASE_URL and run pnpm db:migrate to include it", () => {
    it("needs a database", () => undefined);
  });
} else {
  const prisma = new PrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  runStorageContractTests(
    async () => {
      await prisma.mcpOAuthToken.deleteMany();
      await prisma.mcpOAuthClient.deleteMany();

      const session = buildDemoOfflineSession(DEMO_SHOP, "read_products");
      await prisma.session.upsert({ where: { id: session.id }, update: {}, create: session });

      // Session rows key on the domain, so the shop's id is the domain itself — the same
      // ShopRef that shopifySessionStorage produces at runtime.
      return prismaStorage(prisma, { shop: { model: "session", domainField: "shop", idField: "shop" } });
    },
    { seedShop: { id: DEMO_SHOP, domain: DEMO_SHOP } }
  );
}
