import { Session } from "@shopify/shopify-api";
import { MemorySessionStorage } from "@shopify/shopify-app-session-storage-memory";
import {
  memoryStorage,
  shopifySessionStorage,
  type OAuthStorage,
  type ShopifySessionStorageLike,
} from "shopify-mcp-oauth";
import { createConsoleAuditSink, type AuditSink } from "./audit";
import { buildDemoOfflineSession } from "./demoSession";

export function createMemoryStorage(demoShopDomain: string): {
  storage: OAuthStorage;
  sessionStorage: ShopifySessionStorageLike;
  auditSink: AuditSink;
} {
  const sessions = new MemorySessionStorage();
  void sessions.storeSession(new Session(buildDemoOfflineSession(demoShopDomain, "read_products")));

  return {
    storage: {
      ...memoryStorage(),
      findShopByDomain: shopifySessionStorage(sessions),
    },
    sessionStorage: sessions,
    auditSink: createConsoleAuditSink(),
  };
}

const demo = createMemoryStorage(process.env.DEMO_SHOP_DOMAIN ?? "demo.myshopify.com");

export const storage = demo.storage;
export const sessionStorage = demo.sessionStorage;
export const auditSink = demo.auditSink;
