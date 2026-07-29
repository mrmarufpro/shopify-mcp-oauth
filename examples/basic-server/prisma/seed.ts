import { PrismaClient } from "@prisma/client";
import { buildDemoOfflineSession } from "../src/demoSession";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const shopDomain = process.env.DEMO_SHOP_DOMAIN ?? "demo.myshopify.com";
  const scope = process.env.SHOPIFY_SCOPES ?? "read_products";
  const session = buildDemoOfflineSession(shopDomain, scope);

  await prisma.session.upsert({ where: { id: session.id }, update: {}, create: session });

  console.log(`Seeded an offline session for ${shopDomain}.`);
  console.log("Pick this exact store in Shopify's shop picker, or the callback returns shop_not_installed.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
