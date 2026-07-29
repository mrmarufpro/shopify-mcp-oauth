import express, { type Express, type RequestHandler } from "express";
import { createShopifyMcpOAuth, type OAuthStorage } from "shopify-mcp-oauth";
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
    .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. Use POST /mcp." }, id: null });
};

export function createApp(deps: AppDeps): Express {
  const oauth = createShopifyMcpOAuth({
    host: deps.host,
    shopify: deps.shopify,
    stateSecret: deps.stateSecret,
    storage: deps.storage,
    fetchImpl: deps.fetchImpl,
  });

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use(oauth.router);

  app.post("/mcp", oauth.requireAuth, createMcpHandler({ audit: deps.audit }));
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  // Must be the LAST app.use(...) call, after every body-parser and route above (oauth.router
  // included) -- a body-parser's SyntaxError on malformed JSON is thrown before Express ever
  // reaches oauth.router, so an error handler mounted inside that router can't catch it. Only an
  // error handler registered here, at this app's own outermost level, sees it.
  app.use(oauth.errorHandler);

  return app;
}
