import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "./storage.memory";

const DEMO_SHOP = "demo.myshopify.com";
const UNINSTALLED_SHOP = "never-installed.myshopify.com";

describe("createMemoryStorage", () => {
  it("resolves the seeded demo shop, keyed by its domain", async () => {
    const { storage } = createMemoryStorage(DEMO_SHOP);
    expect(await storage.findShopByDomain(DEMO_SHOP)).toEqual({ id: DEMO_SHOP, domain: DEMO_SHOP });
  });

  it("rejects a shop that was never seeded, which is the install gate", async () => {
    const { storage } = createMemoryStorage(DEMO_SHOP);
    expect(await storage.findShopByDomain(UNINSTALLED_SHOP)).toBeNull();
  });

  it("seeds the session through the real Shopify session storage interface", async () => {
    const { sessionStorage } = createMemoryStorage(DEMO_SHOP);
    const sessions = await sessionStorage.findSessionsByShop(DEMO_SHOP);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.isOnline).toBe(false);
  });

  it("stores and reads back a client, so the OAuth routes have somewhere to write", async () => {
    const { storage } = createMemoryStorage(DEMO_SHOP);
    await storage.createClient({
      clientId: "memory-client",
      clientName: "Memory Client",
      redirectUris: ["https://client.example/callback"],
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      logoUri: null,
      clientUri: null,
      tokenEndpointAuthMethod: "none",
    });
    expect((await storage.findClient("memory-client"))?.clientName).toBe("Memory Client");
  });
});
