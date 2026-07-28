import { describe, expect, it, vi } from "vitest";
import { shopifySessionStorage, type ShopifySessionLike } from "./shopifySessionStorage";

const DEMO_SHOP = "demo.myshopify.com";
const OTHER_SHOP = "other.myshopify.com";
const OFFLINE_TOKEN = "shpua_offline_token";
const EMPTY_TOKEN = "";

function buildSessionStorage(sessions: ShopifySessionLike[]) {
  return { findSessionsByShop: vi.fn().mockResolvedValue(sessions) };
}

describe("shopifySessionStorage", () => {
  it("resolves a shop that has an offline session with an access token", async () => {
    const lookup = shopifySessionStorage(
      buildSessionStorage([{ shop: DEMO_SHOP, isOnline: false, accessToken: OFFLINE_TOKEN }])
    );
    expect(await lookup(DEMO_SHOP)).toEqual({ id: DEMO_SHOP, domain: DEMO_SHOP });
  });

  it("returns null when the shop has no sessions", async () => {
    const lookup = shopifySessionStorage(buildSessionStorage([]));
    expect(await lookup(DEMO_SHOP)).toBeNull();
  });

  it("ignores online sessions, which do not carry an app-level grant", async () => {
    const lookup = shopifySessionStorage(
      buildSessionStorage([{ shop: DEMO_SHOP, isOnline: true, accessToken: OFFLINE_TOKEN }])
    );
    expect(await lookup(DEMO_SHOP)).toBeNull();
  });

  it("ignores an offline session with no access token", async () => {
    const lookup = shopifySessionStorage(buildSessionStorage([{ shop: DEMO_SHOP, isOnline: false }]));
    expect(await lookup(DEMO_SHOP)).toBeNull();
  });

  it("returns null when the session storage throws", async () => {
    const lookup = shopifySessionStorage({
      findSessionsByShop: vi.fn().mockRejectedValue(new Error("redis down")),
    });
    expect(await lookup(DEMO_SHOP)).toBeNull();
  });

  it("ignores an offline session with an empty-string access token", async () => {
    const lookup = shopifySessionStorage(
      buildSessionStorage([{ shop: DEMO_SHOP, isOnline: false, accessToken: EMPTY_TOKEN }])
    );
    expect(await lookup(DEMO_SHOP)).toBeNull();
  });

  it("returns null when a session belongs to a different shop", async () => {
    const lookup = shopifySessionStorage(
      buildSessionStorage([{ shop: OTHER_SHOP, isOnline: false, accessToken: OFFLINE_TOKEN }])
    );
    expect(await lookup(DEMO_SHOP)).toBeNull();
  });

  it("returns null when the session storage resolves a non-array", () => {
    const lookup = shopifySessionStorage({
      findSessionsByShop: vi.fn().mockResolvedValue(undefined),
    });
    return expect(lookup(DEMO_SHOP)).resolves.toBeNull();
  });

  it("resolves the first qualifying session when multiple sessions exist", async () => {
    const lookup = shopifySessionStorage(
      buildSessionStorage([
        { shop: DEMO_SHOP, isOnline: true, accessToken: OFFLINE_TOKEN },
        { shop: OTHER_SHOP, isOnline: false, accessToken: OFFLINE_TOKEN },
        { shop: DEMO_SHOP, isOnline: false, accessToken: OFFLINE_TOKEN },
      ])
    );
    expect(await lookup(DEMO_SHOP)).toEqual({ id: DEMO_SHOP, domain: DEMO_SHOP });
  });
});
