import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "./adapters/memoryStorage";
import { mountShopifyMcpOAuth, type ShopifyMcpOAuthConfig } from "./index";
import type { Logger } from "./types";

const HOST = "https://mcp.example.com";
const DEMO_SHOP = "demo.myshopify.com";
const DEMO_SHOP_ID = "shop_1";

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function buildConfig(): ShopifyMcpOAuthConfig {
  return {
    host: HOST,
    shopify: { apiKey: "test-api-key", apiSecret: "test-api-secret", scopes: "read_products" },
    stateSecret: "test-state-secret-at-least-32-bytes-long",
    storage: memoryStorage({ shops: [{ id: DEMO_SHOP_ID, domain: DEMO_SHOP }] }),
    logger: silentLogger,
  };
}

describe("mountShopifyMcpOAuth", () => {
  it("serves the discovery documents", async () => {
    const app = express();
    mountShopifyMcpOAuth(app, buildConfig(), () => {});

    const response = await request(app).get("/.well-known/oauth-protected-resource");

    expect(response.status).toBe(200);
    expect(response.body.resource).toBe(`${HOST}/mcp`);
  });

  it("returns the same handle createShopifyMcpOAuth would", () => {
    const oauth = mountShopifyMcpOAuth(express(), buildConfig(), () => {});

    expect(typeof oauth.requireAuth).toBe("function");
    expect(typeof oauth.authenticate).toBe("function");
    expect(typeof oauth.challenge).toBe("function");
    expect(typeof oauth.errorHandler).toBe("function");
  });

  it("passes the handle to the route callback exactly once", () => {
    const registerRoutes = vi.fn();
    const oauth = mountShopifyMcpOAuth(express(), buildConfig(), registerRoutes);

    expect(registerRoutes).toHaveBeenCalledTimes(1);
    expect(registerRoutes).toHaveBeenCalledWith(oauth);
  });

  it("protects a route the callback registers", async () => {
    const app = express();
    const downstream = vi.fn();
    mountShopifyMcpOAuth(app, buildConfig(), (oauth) => {
      app.post("/mcp", oauth.requireAuth, (_req, res) => {
        downstream();
        res.json({ ok: true });
      });
    });

    const response = await request(app).post("/mcp").send({});

    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("resource_metadata");
    expect(downstream).not.toHaveBeenCalled();
  });

  // The whole reason this helper exists. An error handler mounted anywhere but the app's own final
  // position lets a body-parser SyntaxError fall through to Express's default handler, which
  // answers an HTML stack trace on an unauthenticated endpoint. Registering routes through the
  // callback is what makes that placement impossible to get wrong.
  it("catches a body-parser error from a consumer route as JSON, not an HTML stack trace", async () => {
    const app = express();
    app.use(express.json());
    mountShopifyMcpOAuth(app, buildConfig(), (oauth) => {
      app.post("/mcp", oauth.requireAuth, (_req, res) => res.json({ ok: true }));
    });

    const response = await request(app).post("/mcp").set("Content-Type", "application/json").send("{ not json");

    // 400, not 500: a body this server could not parse is the client's error, and errorHandler
    // reads the status body-parser put on it. What this case is really pinning is the shape --
    // this package's JSON, from this package's handler, rather than Express's default HTML.
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "invalid_request",
      error_description: "The request body could not be parsed",
    });
    expect(response.text).not.toContain("SyntaxError");
  });
});

// `requireAuth` is documented as the mount-and-forget form of `authenticate` + `challenge`. It was
// built from a SECOND Authenticator, so that claim was only true by coincidence of both copies
// behaving alike -- wrapping `oauth.authenticate` (tenant-scoped logging, a forced failure in a
// test) left the protected route running the untouched copy, which is the failure mode that makes
// a security seam look wired when it isn't.
describe("requireAuth and oauth.authenticate are the same seam", () => {
  it("routes a protected request through a replacement assigned to oauth.authenticate", async () => {
    const app = express();
    const downstream = vi.fn();
    const oauth = mountShopifyMcpOAuth(app, buildConfig(), (mounted) => {
      app.post("/mcp", mounted.requireAuth, (req, res) => {
        downstream();
        res.status(200).json(req.mcp);
      });
    });

    const stubbedContext = { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, tokenId: "token-from-the-wrapper" };
    oauth.authenticate = vi.fn().mockResolvedValue({ ok: true, context: stubbedContext });

    // No Authorization header at all: the real authenticate would refuse this with 401, so a 200
    // carrying the wrapper's own context is only reachable if requireAuth went through it.
    const response = await request(app).post("/mcp").send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual(stubbedContext);
    expect(downstream).toHaveBeenCalledTimes(1);
    expect(oauth.authenticate).toHaveBeenCalledTimes(1);
  });
});
