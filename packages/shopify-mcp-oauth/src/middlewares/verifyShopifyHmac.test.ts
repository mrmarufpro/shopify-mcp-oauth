import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { requireShopifyHmac, verifyShopifyHmac } from "./verifyShopifyHmac";

const API_SECRET = "test-api-secret";
const DEMO_SHOP = "demo.myshopify.com";

function signQuery(params: Record<string, string>): string {
  const message = new URLSearchParams(params).toString();
  const hmac = crypto.createHmac("sha256", API_SECRET).update(message).digest("hex");
  return `${message}&hmac=${hmac}`;
}

describe("verifyShopifyHmac", () => {
  it("accepts a query Shopify signed", () => {
    expect(verifyShopifyHmac(signQuery({ shop: DEMO_SHOP, code: "abc" }), API_SECRET)).toBe(true);
  });

  it("rejects a query with no hmac", () => {
    expect(verifyShopifyHmac(`shop=${DEMO_SHOP}&code=abc`, API_SECRET)).toBe(false);
  });

  it("rejects a tampered parameter", () => {
    const signed = signQuery({ shop: DEMO_SHOP, code: "abc" });
    expect(verifyShopifyHmac(signed.replace("code=abc", "code=xyz"), API_SECRET)).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    expect(verifyShopifyHmac(signQuery({ shop: DEMO_SHOP }), "a-different-secret")).toBe(false);
  });

  it("fails closed instead of throwing when the hmac value is malformed percent-encoding", () => {
    // decodeURIComponent throws a URIError on a lone "%"; this pins the guard's own failure mode
    // (return false) rather than letting that throw escape into an unhandled middleware crash.
    expect(() => verifyShopifyHmac(`shop=${DEMO_SHOP}&hmac=%`, API_SECRET)).not.toThrow();
    expect(verifyShopifyHmac(`shop=${DEMO_SHOP}&hmac=%`, API_SECRET)).toBe(false);
  });
});

describe("requireShopifyHmac", () => {
  function buildApp() {
    const app = express();
    app.get("/oauth/shopify-callback", requireShopifyHmac(API_SECRET), (_req, res) => {
      res.status(200).send("reached the controller");
    });
    return app;
  }

  it("passes a correctly signed request through", async () => {
    const response = await request(buildApp()).get(`/oauth/shopify-callback?${signQuery({ shop: DEMO_SHOP })}`);
    expect(response.status).toBe(200);
  });

  it("blocks an unsigned request with 400", async () => {
    const response = await request(buildApp()).get(`/oauth/shopify-callback?shop=${DEMO_SHOP}`);
    expect(response.status).toBe(400);
  });

  it("blocks a request whose parameter was tampered with after signing, with 400", async () => {
    const signed = signQuery({ shop: DEMO_SHOP, code: "abc" });
    const tampered = signed.replace("code=abc", "code=xyz");
    const response = await request(buildApp()).get(`/oauth/shopify-callback?${tampered}`);
    expect(response.status).toBe(400);
    expect(response.text).toBe("invalid hmac");
  });
});
