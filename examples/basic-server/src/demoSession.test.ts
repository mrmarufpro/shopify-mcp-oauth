import { describe, expect, it } from "vitest";
import { buildDemoOfflineSession } from "./demoSession";

const DEMO_SHOP = "demo.myshopify.com";
const SCOPES = "read_products,write_products";

describe("buildDemoOfflineSession", () => {
  it("uses Shopify's offline session id convention so a real install overwrites it", () => {
    expect(buildDemoOfflineSession(DEMO_SHOP, SCOPES).id).toBe(`offline_${DEMO_SHOP}`);
  });

  it("records the shop and the scopes it was seeded with", () => {
    const session = buildDemoOfflineSession(DEMO_SHOP, SCOPES);
    expect(session.shop).toBe(DEMO_SHOP);
    expect(session.scope).toBe(SCOPES);
  });

  it("is offline and carries an access token, which is what the install gate checks", () => {
    const session = buildDemoOfflineSession(DEMO_SHOP, SCOPES);
    expect(session.isOnline).toBe(false);
    expect(session.accessToken.length).toBeGreaterThan(0);
  });
});
