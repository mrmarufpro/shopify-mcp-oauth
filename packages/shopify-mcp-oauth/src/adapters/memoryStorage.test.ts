import { describe, expect, it } from "vitest";
import { runStorageContractTests } from "../testing/storageContract";
import { memoryStorage } from "./memoryStorage";

const DEMO_SHOP = "demo.myshopify.com";
const DEMO_SHOP_ID = "shop_1";

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
