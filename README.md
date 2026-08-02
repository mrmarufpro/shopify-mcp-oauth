# shopify-mcp

An MCP server boilerplate for Shopify apps, where the merchant logs in through Shopify instead of
copy-pasting a token.

Two packages:

| Package                                             | What it is                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| [`shopify-mcp-oauth`](packages/shopify-mcp-oauth)   | The OAuth layer: authorization server, resource server, and `requireAuth` |
| [`create-shopify-mcp`](packages/create-shopify-mcp) | `npx create-shopify-mcp my-mcp` — scaffolds a running server              |

Plus [`examples/basic-server`](examples/basic-server), which is both the demo and the scaffolder's
template.

## Quickstart

```bash
npx create-shopify-mcp my-mcp
cd my-mcp && pnpm install
cp .env.example .env      # add your Shopify API key and secret
docker compose up -d
pnpm db:migrate && pnpm db:seed
pnpm dev
```

Then expose it with a tunnel, set `MCP_HOST`, add `<MCP_HOST>/oauth/shopify-callback` to your Partner
app's allowed redirection URLs, and connect:

```bash
claude mcp add --transport http my-mcp https://<your-tunnel>/mcp
```

## Why this exists

The hard part of building an MCP server for a Shopify app is not the tools — it is the auth. The MCP
specification requires the server to be **both** an OAuth resource server and an OAuth authorization
server, to support PKCE, to accept two different client-identification schemes, and to serve six
discovery documents that different clients look for in different places. Get one wrong and Claude
Code, VS Code, Cursor, and ChatGPT each fail in a different, silent way.

This ships that layer, and leaves the tools to you.

## Using the package directly

```ts
import express from "express";
import { createShopifyMcpOAuth, prismaStorage, shopifySessionStorage, redisCache } from "shopify-mcp-oauth";

const oauth = createShopifyMcpOAuth({
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
});

const app = express();
app.use(express.json());
app.use(oauth.router);
app.post("/mcp", oauth.requireAuth, myMcpHandler);

// Must be the LAST app.use(...) call, after every body-parser and route above (oauth.router
// included) -- a body-parser's SyntaxError on malformed JSON is thrown before Express ever
// reaches oauth.router, so an error handler mounted inside that router can't catch it. Only an
// error handler registered here, at this app's own outermost level, sees it.
app.use(oauth.errorHandler);
```

`requireAuth` sets `req.mcp = { shopId, shopDomain, tokenId }`.

## Configuration

| Field                          | Required | Default                            | Notes                                                                                                               |
| ------------------------------ | -------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `host`                         | yes      | —                                  | Public origin, HTTPS in production, no trailing slash. Every issued URL derives from this.                          |
| `shopify.apiKey` / `apiSecret` | yes      | —                                  | Your Shopify app's credentials — the same app the merchant installed.                                               |
| `shopify.scopes`               | yes      | —                                  | Comma-separated. Must match the installed app's scopes or Shopify re-prompts.                                       |
| `stateSecret`                  | yes      | —                                  | HS256 signing key for the state JWT. At least 32 bytes.                                                             |
| `storage`                      | yes      | —                                  | An `OAuthStorage`. See [docs/storage-adapters.md](docs/storage-adapters.md).                                        |
| `cache`                        | no       | `memoryCache()`                    | Holds authorization codes and fetched client metadata documents.                                                    |
| `tokenTtl.access`              | no       | `3600`                             | Seconds.                                                                                                            |
| `tokenTtl.refresh`             | no       | `2592000`                          | Seconds — 30 days.                                                                                                  |
| `openaiAppsChallengeToken`     | no       | `null`                             | Only needed to list the server as a ChatGPT app. The route is omitted when null.                                    |
| `registerRateLimit`            | no       | `{ limit: 20, windowMs: 3600000 }` | Dynamic client registration is unauthenticated by definition.                                                       |
| `revokeRateLimit`              | no       | `{ limit: 20, windowMs: 3600000 }` | `/revoke` is also unauthenticated by design (RFC 7009) — its own field, tuned independently of `registerRateLimit`. |
| `logger`                       | no       | `console`                          | Anything with `info` / `warn` / `error`.                                                                            |
| `fetchImpl`                    | no       | the global `fetch`                 | Test seam: the package uses this for Shopify's own token exchange and for fetching client-metadata documents.       |

Configuration is validated when you construct it. A missing or malformed value throws immediately,
naming the field — never at the first request.

## How login works

```
1. Client reads /.well-known/oauth-protected-resource (or is pointed there by a 401).
2. Client identifies itself — either a client-metadata URL, or by registering at /register.
3. Client opens a browser at /authorize with a PKCE challenge.
4. We redirect to Shopify's shop picker. The merchant chooses a store and approves.
5. Shopify calls /oauth/shopify-callback. We verify its HMAC and exchange the code —
   proof the merchant controls that shop. The Shopify token is then discarded.
6. We check the shop is one you know. If not: 403 shop_not_installed.
7. We issue a 60-second authorization code, the client redeems it at /token with its
   PKCE verifier, and gets an access token and a refresh token.
8. The client calls POST /mcp with `Authorization: Bearer <access_token>`.
```

The merchant's browser is the only participant that talks to Shopify during consent.

## The install gate

Step 6 is load-bearing. Completing Shopify's flow does **not** prove the app was already installed —
Shopify installs it on approval if it was not. Without the shop lookup, any merchant on Shopify could
mint a token for your server. `allowAnyShop()` removes that check; only use it if your app genuinely
keeps no per-shop record.

## Read this before deploying

**The default cache is single-process.** Authorization codes live in the cache, so with more than one
instance a login started on one instance fails on another, and the client reports an opaque
`invalid_grant`. Pass `cache: redisCache(redis)` before you scale past one process.

Other decisions worth knowing:

- Access and refresh tokens are stored as SHA-256 hashes — a database leak yields no usable tokens.
- PKCE S256 only. `plain` is rejected.
- Redirect URIs must match exactly, except that `localhost` and `127.0.0.1` ignore the port, which
  RFC 8252 requires for native clients binding an ephemeral port.
- Client-metadata documents are fetched with SSRF guards: HTTPS only, no private or loopback
  addresses, no redirects followed, a size cap, and a hard timeout.
- Refresh rotates: redeeming a refresh token revokes it and issues a new pair.
- `/revoke` answers 200 whether or not the submitted token existed, per RFC 7009, so it cannot be
  used to probe which tokens exist. A rate limiter sits in front of the endpoint (`revokeRateLimit`
  above) and can answer 429 under heavy call volume from one caller — that carries no information
  about any particular token's validity, so it doesn't reopen the oracle RFC 7009 guards against.

## Development

```bash
pnpm install
pnpm build        # required before the example's tests — they import the built package
pnpm test
pnpm typecheck
pnpm lint
```

## License

MIT.
