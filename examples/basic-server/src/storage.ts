import { PrismaClient } from "@prisma/client";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import {
  prismaStorage,
  shopifySessionStorage,
  type OAuthStorage,
  type ShopifySessionStorageLike,
} from "shopify-mcp-oauth";
import { createPrismaAuditSink, type AuditSink } from "./audit";

export const prisma = new PrismaClient();

// Swap this one line for `new RedisSessionStorage(redis)` — or the Mongo, DynamoDB, or KV adapter —
// and nothing below changes. The shop lookup binds to Shopify's SessionStorage interface, not a table.
export const sessionStorage: ShopifySessionStorageLike = new PrismaSessionStorage(prisma);

export const storage: OAuthStorage = {
  ...prismaStorage(prisma),
  findShopByDomain: shopifySessionStorage(sessionStorage),
};

export const auditSink: AuditSink = createPrismaAuditSink(prisma);
