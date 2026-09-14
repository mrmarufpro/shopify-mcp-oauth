import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Express } from "express";
import { allowAnyShop, memoryStorage, mountShopifyMcpOAuth, RECOMMENDED_RATE_LIMIT } from "shopify-mcp-oauth";
import { buildMcpServer } from "./tools";

export interface AppOptions {
  host: string;
  shopify: { apiKey: string; apiSecret: string; scopes: string };
  stateSecret: string;
}

export function createApp(options: AppOptions): Express {
  const app = express();
  app.set("trust proxy", 1);
  // The OAuth router parses its own routes' bodies; this one is for /mcp below.
  app.use(express.json());

  // Mounts the OAuth endpoints (/.well-known/…, /register, /authorize, /token, /revoke, and the
  // Shopify callback), then your protected routes, then the package's error handler last. Passing
  // routes in the callback is what guarantees that order — a route added after this call would sit
  // below the error handler and lose its cover.
  mountShopifyMcpOAuth(
    app,
    {
      host: options.host,
      shopify: options.shopify,
      stateSecret: options.stateSecret,
      storage: {
        // Clients and tokens live in this process: fine to try out, lost on restart, and invisible
        // to a second instance. Swap in `prismaStorage(prisma)` before deploying.
        ...memoryStorage(),
        // No install gate: any merchant who completes Shopify's login gets a token. A real app
        // resolves the shop against its own records here so a merchant it has never installed for
        // is refused — see the README.
        findShopByDomain: allowAnyShop(),
      },
      // /register and /revoke are unauthenticated and uncapped unless you ask for a limit, so ask
      // for one. One budget covers both. Counted in this process; pass a `store` to share the
      // count across instances.
      rateLimit: RECOMMENDED_RATE_LIMIT,
    },
    (oauth) => {
      app.post("/mcp", oauth.requireAuth, async (req, res) => {
        // requireAuth already answered 401 if the bearer token was missing, expired, or scoped to
        // another resource, so req.mcp is set by the time this runs.
        const auth = req.mcp!;

        // Stateless: a fresh McpServer and transport per request, both closed with the response.
        // Because the server is built per request, tools can close over `auth` directly.
        const server = buildMcpServer(auth);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

        res.on("close", () => {
          void transport.close();
          void server.close();
        });

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      });
    }
  );

  return app;
}
