# shopify-mcp-oauth

OAuth 2.1 authorization server **and** resource server for a Shopify app's MCP endpoint, so the
merchant logs in through Shopify instead of copy-pasting a token.

The hard part of an MCP server for a Shopify app is not the tools — it is the auth. The MCP
specification requires the server to be both an OAuth resource server and an OAuth authorization
server, to support PKCE, to accept two different client-identification schemes, and to serve six
discovery documents that different clients look for in different places. Get one wrong and Claude
Code, VS Code, Cursor, and ChatGPT each fail in a different, silent way.

This package ships that layer and leaves the tools to you. It is **not** a Shopify app framework —
no install, billing, webhooks, or embedded admin UI — and **not** an MCP transport library.

> **Pre-1.0.** While the version is `0.x`, a **minor** bump may contain breaking changes and a
> **patch** bump will not. Pin accordingly.

## Install

```bash
npm install shopify-mcp-oauth
```

Peer dependencies: `express >=5` and `zod >=3.23`.

## Quickstart

```ts
import express from "express";
import { mountShopifyMcpOAuth, prismaStorage, shopifySessionStorage, redisCache } from "shopify-mcp-oauth";

const app = express();
app.use(express.json()); // for YOUR routes; the OAuth router parses its own

mountShopifyMcpOAuth(
  app,
  {
    host: "https://mcp.example.com",
    shopify: {
      apiKey: process.env.SHOPIFY_API_KEY!,
      apiSecret: process.env.SHOPIFY_API_SECRET!,
      scopes: "read_products,write_products",
    },
    stateSecret: process.env.OAUTH_STATE_SECRET!,
    storage: {
      ...prismaStorage(prisma),
      findShopByDomain: shopifySessionStorage(sessionStorage),
    },
    cache: redisCache(redis),
  },
  (oauth) => {
    app.post("/mcp", oauth.requireAuth, myMcpHandler);
  }
);
```

`requireAuth` sets `req.mcp = { shopId, shopDomain, tokenId }` and answers 401 with a
`WWW-Authenticate` header when authentication fails. The `req.mcp` type is available without any
extra import — the package augments `Express.Request` globally on import.

`mountShopifyMcpOAuth` mounts the router, then your routes, then the error handler **last**. That
last position is the one that matters: Express only looks for an error handler at the stack level
where the error was thrown, so a body-parser `SyntaxError` on malformed JSON never reaches one
mounted inside a router, and Express's default handler answers with an HTML stack trace on an
unauthenticated endpoint instead. Register every route inside the callback — anything added to `app`
afterwards sits below the error handler.

`createShopifyMcpOAuth` returns the same handle without mounting anything, if you would rather place
the three pieces yourself.

## Configuration

| Field                          | Required | Default         | Notes                                                            |
| ------------------------------ | -------- | --------------- | ---------------------------------------------------------------- |
| `host`                         | yes      | —               | Public origin, HTTPS in production, no trailing slash.           |
| `shopify.apiKey` / `apiSecret` | yes      | —               | The same Shopify app the merchant installed.                     |
| `shopify.scopes`               | yes      | —               | Comma-separated. Must match the installed app's scopes.          |
| `stateSecret`                  | yes      | —               | HS256 signing key for the state JWT. At least 32 characters.     |
| `storage`                      | yes      | —               | An `OAuthStorage`. See the storage adapters guide.               |
| `cache`                        | no       | `memoryCache()` | Holds authorization codes and fetched client metadata documents. |
| `onShopNotFound`               | no       | `null`          | Last-chance shop resolution when the install gate misses.        |
| `tokenTtl.access`              | no       | `3600`          | Seconds.                                                         |
| `tokenTtl.refresh`             | no       | `2592000`       | Seconds — 30 days.                                               |

The full table, including `cimdFetchConcurrency` and `openaiAppsChallengeToken`, is in the
[repository README](https://github.com/mrmarufpro/shopify-mcp-oauth#configuration).

## Storage

Storage-agnostic by design — the package never assumes an ORM. Built-in adapters:
`prismaStorage`, `memoryStorage`, `shopifySessionStorage`, `redisCache`, `memoryCache`,
`allowAnyShop`. Writing your own means implementing the `OAuthStorage` and `CacheStore` interfaces:
[storage adapters guide](https://github.com/mrmarufpro/shopify-mcp-oauth/blob/main/docs/storage-adapters.md).

## Guides

- [Adding this to an MCP server you already have](https://github.com/mrmarufpro/shopify-mcp-oauth/blob/main/docs/integrating-an-existing-server.md)
- [Storage adapters](https://github.com/mrmarufpro/shopify-mcp-oauth/blob/main/docs/storage-adapters.md)

Starting from scratch? [`create-shopify-mcp`](https://www.npmjs.com/package/create-shopify-mcp)
scaffolds a running server with this already wired.

## License

MIT
