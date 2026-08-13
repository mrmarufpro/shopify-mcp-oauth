import express, { type Express, type RequestHandler } from "express";
import { mountShopifyMcpOAuth, type OAuthStorage } from "shopify-mcp-oauth";
import type { AuditSink } from "./audit";
import { createMcpHandler } from "./mcp/transport";

export interface AppDeps {
  host: string;
  shopify: { apiKey: string; apiSecret: string; scopes: string };
  stateSecret: string;
  storage: OAuthStorage;
  audit: AuditSink;
  /** Test seam: the OAuth package uses this for Shopify's token exchange. */
  fetchImpl?: typeof fetch;
}

const methodNotAllowed: RequestHandler = (_req, res) => {
  res
    .status(405)
    .set("Allow", "POST")
    .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. Use POST /mcp." }, id: null });
};

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.set("trust proxy", 1);
  // For this app's own /mcp route. The OAuth router parses its own routes' bodies.
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Mounts the OAuth router, then the callback's routes, then the package's error handler last --
  // that final position is the one that matters and the one this helper exists to guarantee. A
  // body-parser's SyntaxError on malformed JSON is thrown at this app's level, before Express ever
  // reaches the OAuth router, so an error handler mounted inside that router cannot catch it; with
  // nothing at the outermost level, Express's default handler answers an HTML stack trace on an
  // unauthenticated endpoint instead. Every route this app serves therefore goes inside the
  // callback -- one added after this call would sit below the error handler and lose that cover.
  mountShopifyMcpOAuth(
    app,
    {
      host: deps.host,
      shopify: deps.shopify,
      stateSecret: deps.stateSecret,
      storage: deps.storage,
      fetchImpl: deps.fetchImpl,
    },
    (oauth) => {
      app.post("/mcp", oauth.requireAuth, createMcpHandler({ audit: deps.audit }));
      app.get("/mcp", methodNotAllowed);
      app.delete("/mcp", methodNotAllowed);
    }
  );

  return app;
}
