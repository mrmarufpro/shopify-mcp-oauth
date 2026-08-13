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

  it("registers routes with no callback at all", async () => {
    const app = express();
    mountShopifyMcpOAuth(app, buildConfig());

    expect((await request(app).get("/.well-known/oauth-authorization-server")).status).toBe(200);
  });
});
