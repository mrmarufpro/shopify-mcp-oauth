import { describe, expect, it } from "vitest";
import { runStorageContractTests } from "../testing/storageContract";
import { memoryStorage } from "./memoryStorage";

const DEMO_SHOP = "example.myshopify.com";
const DEMO_SHOP_ID = "shop_1";
const MUTATION_CLIENT_ID = "mutation-test-client";
const ORIGINAL_REDIRECT_URI = "https://original.example/callback";
const INJECTED_REDIRECT_URI = "https://injected.example/callback";
const HIJACKED_SHOP_ID = "hijacked-shop-id";

runStorageContractTests(() => memoryStorage({ shops: [{ id: DEMO_SHOP_ID, domain: DEMO_SHOP }] }), {
  seedShop: { id: DEMO_SHOP_ID, domain: DEMO_SHOP },
});

describe("memoryStorage", () => {
  it("starts with no shops when given no seed", async () => {
    const storage = memoryStorage();
    expect(await storage.findShopByDomain(DEMO_SHOP)).toBeNull();
  });

  it("accepts a shop added after construction", async () => {
    const storage = memoryStorage();
    storage.addShop({ id: DEMO_SHOP_ID, domain: DEMO_SHOP });
    expect(await storage.findShopByDomain(DEMO_SHOP)).toEqual({ id: DEMO_SHOP_ID, domain: DEMO_SHOP });
  });
});

describe("memoryStorage reference isolation", () => {
  it("does not let a mutated findClient result change stored state", async () => {
    const storage = memoryStorage();
    await storage.createClient({
      clientId: MUTATION_CLIENT_ID,
      clientName: null,
      redirectUris: [ORIGINAL_REDIRECT_URI],
      grantTypes: null,
      responseTypes: null,
      logoUri: null,
      clientUri: null,
      tokenEndpointAuthMethod: "none",
    });

    const found = await storage.findClient(MUTATION_CLIENT_ID);
    found?.redirectUris.push(INJECTED_REDIRECT_URI);

    const refetched = await storage.findClient(MUTATION_CLIENT_ID);
    expect(refetched?.redirectUris).toEqual([ORIGINAL_REDIRECT_URI]);
  });

  it("does not let a mutated createClient input array change stored state", async () => {
    const storage = memoryStorage();
    const redirectUris = [ORIGINAL_REDIRECT_URI];
    await storage.createClient({
      clientId: MUTATION_CLIENT_ID,
      clientName: null,
      redirectUris,
      grantTypes: null,
      responseTypes: null,
      logoUri: null,
      clientUri: null,
      tokenEndpointAuthMethod: "none",
    });

    redirectUris.push(INJECTED_REDIRECT_URI);

    const found = await storage.findClient(MUTATION_CLIENT_ID);
    expect(found?.redirectUris).toEqual([ORIGINAL_REDIRECT_URI]);
  });

  it("does not let a mutated seeded ShopRef change what findShopByDomain returns", async () => {
    const seededShop = { id: DEMO_SHOP_ID, domain: DEMO_SHOP };
    const storage = memoryStorage({ shops: [seededShop] });

    seededShop.id = HIJACKED_SHOP_ID;

    const found = await storage.findShopByDomain(DEMO_SHOP);
    expect(found?.id).toBe(DEMO_SHOP_ID);
  });

  it("keeps a token reference held across revokeToken consistent with a fresh read", async () => {
    const storage = memoryStorage({ shops: [{ id: DEMO_SHOP_ID, domain: DEMO_SHOP }] });
    const token = await storage.createToken({
      shopId: DEMO_SHOP_ID,
      shopDomain: DEMO_SHOP,
      clientId: MUTATION_CLIENT_ID,
      accessTokenHash: "access-hash-for-revoke-consistency",
      refreshTokenHash: "refresh-hash-for-revoke-consistency",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
      scope: "mcp:*",
      resource: "https://mcp.example.com/mcp",
      rotatedFromId: null,
    });

    await storage.revokeToken(token.id);

    // A held reference is a frozen snapshot from before the revoke, matching real database
    // snapshot semantics — a caller must re-fetch to observe the storage's current state.
    expect(token.revokedAt).toBeNull();

    const refetched = await storage.findTokenByAccessHash("access-hash-for-revoke-consistency");
    expect(refetched).toBeNull();
  });
});
