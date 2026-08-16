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

**Guides:**

| Doc                                                                             | Read it when                                                  |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [Adding this to an existing MCP server](docs/integrating-an-existing-server.md) | You already have an MCP endpoint and want Shopify login on it |
| [Storage adapters](docs/storage-adapters.md)                                    | You're not on Prisma, or your cache isn't Redis               |

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

## Adding it to a server you already have

Already have an MCP endpoint? This replaces its auth and touches nothing else — your tools,
transport, and business logic stay as they are. Full walkthrough, including the schema it needs and
how to keep a token scheme you already support:
**[docs/integrating-an-existing-server.md](docs/integrating-an-existing-server.md)**.

The wiring itself:

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

`requireAuth` sets `req.mcp = { shopId, shopDomain, tokenId }`.

`mountShopifyMcpOAuth` mounts the router, then your routes, then the error handler **last**. That
last position is the one that matters: Express only looks for an error handler at the stack level
where the error was thrown, so a body-parser `SyntaxError` on malformed JSON never reaches one
mounted inside a router — and Express's default handler answers an HTML stack trace on an
unauthenticated endpoint instead. The helper makes that ordering structural. Its one rule: register
every route inside the callback, because anything added to `app` afterwards sits below the error
handler.

`createShopifyMcpOAuth` returns the same handle without mounting anything, if you'd rather place the
three pieces yourself.

### If you already have a token scheme

`requireAuth` answers the request itself on failure, so nothing can run after it. To accept a second
credential — a personal access token most merchants still use, say — compose the same logic
directly:

```ts
app.post("/mcp", async (req, res, next) => {
  const pat = await myOwnScheme(req);
  if (pat) {
    req.mcp = pat;
    return next();
  }

  const result = await oauth.authenticate(req); // resolves, never responds
  if (!result.ok) return oauth.challenge(res, result.reason); // 401 + WWW-Authenticate
  req.mcp = result.context;
  next();
});
```

`challenge` isn't decoration: the `WWW-Authenticate` header it writes is how a client that has never
seen your server finds out where to log in (RFC 9728).

## Configuration

| Field                          | Required | Default                            | Notes                                                                                                               |
| ------------------------------ | -------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `host`                         | yes      | —                                  | Public origin, HTTPS in production, no trailing slash. Every issued URL derives from this.                          |
| `shopify.apiKey` / `apiSecret` | yes      | —                                  | Your Shopify app's credentials — the same app the merchant installed.                                               |
| `shopify.scopes`               | yes      | —                                  | Comma-separated. Must match the installed app's scopes or Shopify re-prompts.                                       |
| `stateSecret`                  | yes      | —                                  | HS256 signing key for the state JWT. At least 32 characters.                                                        |
| `storage`                      | yes      | —                                  | An `OAuthStorage`. See [docs/storage-adapters.md](docs/storage-adapters.md).                                        |
| `cache`                        | no       | `memoryCache()`                    | Holds authorization codes and fetched client metadata documents.                                                    |
| `onShopNotFound`               | no       | `null`                             | Last-chance shop resolution when the install gate misses. See [The install gate](#the-install-gate).                |
| `cimdFetchConcurrency`         | no       | `10`                               | Caps concurrent fetches of client-metadata documents; requests beyond the cap queue for a free slot.                |
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
6. We check the shop is one you know. If not, `onShopNotFound` gets a last word; otherwise 403.
7. We issue a 60-second authorization code, the client redeems it at /token with its
   PKCE verifier, and gets an access token and a refresh token.
8. The client calls POST /mcp with `Authorization: Bearer <access_token>`.
```

The merchant's browser is the only participant that talks to Shopify during consent.

## The install gate

Step 6 is load-bearing, and it is worth being precise about what it checks.

Reaching it means the app **is** installed on that shop — Shopify grants it on approval, so a
merchant who wasn't a customer a moment ago is one now. What it does not mean is that **your app has
any record of it**. The grant landed on this MCP server's `/oauth/shopify-callback`, and the package
deliberately discards the Shopify token rather than persisting it, so nothing your own install flow
normally writes gets written: no offline session (all the Shopify app template stores), no shop or
store row if your app keeps one, no billing subscription, no webhook registrations, no `afterAuth`.

Without the lookup, that merchant gets tool access anyway — skipping whatever your real install does,
billing first among them, against a shop your app has never heard of. So the gate asks "does my app
already know this shop", not "did Shopify grant the app". `allowAnyShop()` removes it; only use it if
your app genuinely keeps no per-shop record at all.

A miss still isn't always "not a customer". Shopify's managed install grants the app without the
merchant ever opening it, so an app whose record is written when the merchant first opens the
embedded app has nothing yet for a merchant who installed and went straight to an MCP client — and
telling them to install an app they already installed is a dead end. Same principle as above,
arrived at from the other side: the grant exists, your record doesn't. `onShopNotFound` runs at
exactly that point, with the access token just exchanged for the shop:

```ts
onShopNotFound: async ({ domain, accessToken }) => {
  await registerShop(domain, accessToken); // store the offline session; run your own install work
  return storage.findShopByDomain(domain); // null keeps the 403
};
```

For a template-shaped app, "register" is usually just storing the offline session — the thing your
own callback would have stored, which is why the token is handed over here. Apps that keep more of
their own state (a shop row, a billing record, webhook registrations) do that here too.

Returning a shop admits this merchant, so the hook **is** the gate now. Do the work your install
would have done, and return `null` if it fails.

**Return the shop your write actually produced, not one you build by hand.** The `id` has to be the
same id `findShopByDomain` will return for this domain from then on: every authenticated request
re-resolves the shop by domain and checks that row's id against the one in the token. Return an id
that lookup won't produce and the login _succeeds_ while every tool call answers 401 — which the MCP
client reads as "log in again", so it runs the whole flow again, and loops. Returning
`findShopByDomain(domain)` (as above) or the row your insert returned is what avoids that; the
`domain` you return must match the one passed in too, or the callback refuses the login rather than
issue a token scoped to a different store.

## Read this before deploying

**The default cache is single-process.** Authorization codes live in the cache, so with more than one
instance a login started on one instance fails on another, and the client reports an opaque
`invalid_grant`. Pass `cache: redisCache(redis)` before you scale past one process. `redisCache`
takes a node-redis v4-shaped client and issues a queued `MULTI GET+DEL` — atomic, which is what keeps
an authorization code single-use, and available on every Redis version. It does not prefer `GETDEL`:
a client library defining `getDel` says nothing about whether the server implements the command,
which arrived only in 6.2, so on a 6.0/6.1 server that path fails at every login with `ERR unknown
command 'GETDEL'`. `getDel` is used only for a client exposing no `multi()`.

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

## Releasing

Releases run on [Changesets](https://github.com/changesets/changesets). Publishing happens in CI over
npm trusted publishing (OIDC), so there is no npm token in repository secrets and every release
carries a provenance attestation.

1. A pull request that changes either package includes a changeset — run `pnpm changeset`, pick the
   packages and the bump, and commit the generated file. Details in
   [`.changeset/README.md`](.changeset/README.md).
2. Merging to `main` runs `.github/workflows/release.yml`. With changesets pending, it opens or
   updates a **Version Packages** pull request holding the version bumps and CHANGELOG entries.
3. Merging that pull request runs the workflow again. This time it builds, publishes to npm, pushes
   git tags, and creates GitHub releases.

The two packages version independently — a fix in the CLI does not bump the library.

`packages/create-shopify-mcp/templates/` is generated, not source: it is gitignored, and the CLI's
`prepack` hook regenerates it from `examples/basic-server` before every publish, pinning
`shopify-mcp-oauth` at the version being released. `scripts/check-template-pin.mjs` asserts that in
CI. Edit `examples/basic-server`, never the template.

## License

MIT.
