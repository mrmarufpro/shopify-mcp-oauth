import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { requireShopifyHmac, verifyShopifyHmac } from "./verifyShopifyHmac";

const API_SECRET = "test-api-secret";
const DEMO_SHOP = "demo.myshopify.com";

function signQuery(params: Record<string, string>): string {
  // Sorted by key, mirroring the algorithm verifyShopifyHmac itself applies (and the one
  // Shopify's docs document for the sibling installation-request HMAC) -- this is what makes
  // signQuery an accurate stand-in for "how Shopify signs a callback", not just "any string this
  // suite's own signer and verifier happen to agree on".
  const sortedEntries = Object.entries(params).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const message = new URLSearchParams(sortedEntries).toString();
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

  it("verifies a raw %20-encoded space, which a decode/re-encode round trip would turn into a +", () => {
    // A space is %20 in a raw query string but re-serializes as + under URLSearchParams (or
    // querystring.stringify) once it has been decoded -- so a signed message built from the raw
    // bytes and one rebuilt from the decoded value diverge for this exact byte, and only the raw
    // one is what Shopify actually signed.
    const rawQueryWithoutHmac = `shop=${DEMO_SHOP}&state=a%20b`;
    const hmac = crypto.createHmac("sha256", API_SECRET).update(rawQueryWithoutHmac).digest("hex");
    expect(verifyShopifyHmac(`${rawQueryWithoutHmac}&hmac=${hmac}`, API_SECRET)).toBe(true);
  });

  it("verifies a query whose parameters were received out of alphabetical order", () => {
    // Shopify's own callback field set (code, hmac, host, shop, state, timestamp) already arrives
    // in alphabetical order in practice, which is exactly the coincidence that let an
    // un-sorted implementation pass every other test in this file. Reorder deliberately, and sign
    // over the *sorted* base string per the documented algorithm: this only holds if
    // verifyShopifyHmac actually sorts before hashing, not merely joins whatever order it received.
    const rawOutOfOrder = `timestamp=1700000000&shop=${DEMO_SHOP}&code=abc`;
    const sortedBase = `code=abc&shop=${DEMO_SHOP}&timestamp=1700000000`;
    const hmac = crypto.createHmac("sha256", API_SECRET).update(sortedBase).digest("hex");
    expect(verifyShopifyHmac(`${rawOutOfOrder}&hmac=${hmac}`, API_SECRET)).toBe(true);
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

  it("verifies against the raw query string Express received, not a rebuild from req.query", async () => {
    // This is the binding constraint of this whole module: the message must come from
    // req.originalUrl, never be reconstructed from req.query. A %20-encoded space is the vector
    // that exposes a rebuild -- Express decodes it to a literal space in req.query, and
    // re-serializing that (via URLSearchParams, querystring.stringify, or an object) turns it back
    // into "+", not "%20", producing a different base string and therefore a different digest. If
    // requireShopifyHmac is ever changed to source its queryString from req.query instead of
    // req.originalUrl, this test goes red even though every other test in this file -- whose
    // signed values never contain a character with more than one valid percent-encoding -- stays
    // green.
    const rawQueryWithoutHmac = `shop=${DEMO_SHOP}&state=a%20b`;
    const hmac = crypto.createHmac("sha256", API_SECRET).update(rawQueryWithoutHmac).digest("hex");
    const response = await request(buildApp()).get(`/oauth/shopify-callback?${rawQueryWithoutHmac}&hmac=${hmac}`);
    expect(response.status).toBe(200);
  });
});
