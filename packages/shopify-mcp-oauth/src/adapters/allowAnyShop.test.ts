import { describe, expect, it } from "vitest";
import { allowAnyShop } from "./allowAnyShop";

const ANY_SHOP = "never-installed.myshopify.com";

describe("allowAnyShop", () => {
  it("resolves every domain, keyed by the domain itself", async () => {
    expect(await allowAnyShop()(ANY_SHOP)).toEqual({ id: ANY_SHOP, domain: ANY_SHOP });
  });
});
