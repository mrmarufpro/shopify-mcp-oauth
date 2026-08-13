# Adding this to an MCP server you already have

The scaffolder (`npx create-shopify-mcp`) is for a new server. This guide is the other case: you
already have an MCP endpoint for your Shopify app — serving tools, probably authenticated by a token
your merchants paste in — and you want merchants to log in through Shopify instead.

The short version: this package replaces your **auth**, and touches nothing else. Your tools,
transport, rate limits, audit logging, and business logic stay exactly as they are.

| Stays yours                                       | Becomes the package's                                  |
| ------------------------------------------------- | ------------------------------------------------------ |
| Tool definitions and handlers                     | `/authorize`, `/token`, `/register`, `/revoke`         |
| The MCP transport and `POST /mcp` route           | The six `.well-known` discovery documents              |
| Rate limiting, logging, metrics on your own routes | The Shopify OAuth bounce and its HMAC check            |
| Your database, ORM, and migrations                | Token issuance, hashing, expiry, and refresh rotation  |
| Any other credential scheme you support           | Resolving a bearer token to a shop (`req.mcp`)         |

A real migration of a production server (a hand-rolled OAuth 2.1 implementation, ~2,700 lines)
came out at about 300 lines of glue — most of it a storage adapter for an ORM the package doesn't
ship one for. If you use Prisma and `@shopify/shopify-app-*`, it's closer to 30.

## 1. Install and hold a config object

```bash
npm install shopify-mcp-oauth
```

```ts
import { mountShopifyMcpOAuth } from "shopify-mcp-oauth";
```

Two values decide whether anything works, so get them right before writing code:

- **`host`** — your MCP server's public origin, exactly as clients reach it, no trailing slash.
  Every issued URL and the token audience derive from it. If your server sits behind a tunnel or a
  proxy, this is the outside address, not `localhost:3000`.
- **The Partner app redirect URL** — add `<host>/oauth/shopify-callback` to your Shopify Partner
  app's allowed redirection URLs. Shopify refuses the callback otherwise, and the error surfaces in
  the merchant's browser rather than your logs.

Everything else has a default or a compile error waiting for it. See the
[configuration table](../README.md#configuration).

## 2. Give it somewhere to store clients and tokens

Two new tables. Nothing here overlaps your existing schema, so this is additive — no data migration.

```sql
CREATE TABLE mcp_oauth_clients (
  client_id                   VARCHAR(255) PRIMARY KEY,
  client_name                 VARCHAR(255),
  redirect_uris               JSONB        NOT NULL,
  grant_types                 JSONB,
  response_types              JSONB,
  logo_uri                    TEXT,
  client_uri                  TEXT,
  token_endpoint_auth_method  VARCHAR(64)  NOT NULL DEFAULT 'none',
  revoked_at                  TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE mcp_oauth_tokens (
  id                         BIGSERIAL     PRIMARY KEY,
  shop_id                    BIGINT        NOT NULL,
  shop_domain                VARCHAR(255)  NOT NULL,
  client_id                  VARCHAR(255)  NOT NULL,
  access_token_hash          VARCHAR(64)   NOT NULL,
  refresh_token_hash         VARCHAR(64),
  access_token_expires_at    TIMESTAMPTZ   NOT NULL,
  refresh_token_expires_at   TIMESTAMPTZ,
  scope                      VARCHAR(255),
  resource                   VARCHAR(2048),
  revoked_at                 TIMESTAMPTZ,
  rotated_from_id            BIGINT,
  last_used_at               TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX ON mcp_oauth_tokens (access_token_hash);
CREATE INDEX ON mcp_oauth_tokens (refresh_token_hash);
```

Four columns are easy to get wrong:

- **`access_token_hash` / `refresh_token_hash`** hold a SHA-256 hex digest, never a token. Use
  `VARCHAR(64)`, not `CHAR(64)` — Postgres blank-pads `CHAR` on read, and a padded hash won't match
  a lookup. (Real digests are exactly 64 characters, so this bites you in tests and in hand-written
  rows, not in production traffic — which is worse, because it looks like a passing system.)
- **`resource`** is the RFC 8707 audience. It must equal `<host>/mcp` on every row, and the resource
  server compares it with strict equality on every request — a `NULL` here rejects the token.
- **`shop_id`** is a copy of your own shop table's id, not a foreign key the package requires.
  Whatever type your shop ids are (`BIGINT`, `UUID`, `VARCHAR`) is fine; the package treats it as
  `string | number` and compares it stringified.

## 3. Wire storage

If you use Prisma, two lines:

```ts
import { prismaStorage, shopifySessionStorage } from "shopify-mcp-oauth";

const storage = {
  ...prismaStorage(prisma),
  findShopByDomain: shopifySessionStorage(sessionStorage), // or your own shop table
};
```

If you don't, you write an `OAuthStorage` — about 150 lines of mechanical query code, and the
package ships the test suite that proves it correct. That's its own guide:
**[docs/storage-adapters.md](storage-adapters.md)**, which includes a complete worked adapter for a
non-Prisma ORM.

## 4. Wire a shared cache

Authorization codes live in the cache. The default is in-memory, which is single-process: with two
instances, a login started on one fails on the other with an opaque `invalid_grant`.

```ts
import { redisCache } from "shopify-mcp-oauth";

const cache = redisCache(redisClient);
```

`redisCache` takes a node-redis v4-shaped client and issues a queued `MULTI GET+DEL`, which is atomic
— what makes an authorization code single-use — and works on every Redis version.

It deliberately does **not** prefer `GETDEL`. A client library defining `getDel` tells you nothing
about whether the *server* implements the command, which arrived only in Redis 6.2: node-redis v4
exposes the method against any connection, so on a 6.0/6.1 server that path fails at runtime with
`ERR unknown command 'GETDEL'` — at code redemption, on every login, after a boot that looked fine.
There's no client-side check that separates the two, so the universally available command wins.
`getDel` is used only for a client exposing no `multi()`; a client with neither doesn't typecheck.

Any other backend: implement `CacheStore` and run the shipped contract suite against it. Same guide
as above.

## 5. Mount it

```ts
import express from "express";
import { mountShopifyMcpOAuth } from "shopify-mcp-oauth";

const app = express();
app.use(express.json()); // for YOUR routes; the OAuth router parses its own

mountShopifyMcpOAuth(app, { host, shopify, stateSecret, storage, cache }, (oauth) => {
  app.post("/mcp", oauth.requireAuth, myExistingMcpHandler);
});
```

That's the whole wiring. The helper mounts the OAuth router, then your routes, then the package's
error handler **last** — and that last position is load-bearing, which is why the helper exists.
Express only looks for an error handler at the stack level where the error was thrown, so a
malformed-JSON `SyntaxError` from your own body-parser never reaches a handler mounted inside a
router. Miss it and Express's default handler answers an HTML stack trace on an unauthenticated
endpoint.

The one rule the helper can't enforce: **routes added to `app` after this call sit below the error
handler.** Register them inside the callback.

If your app's structure won't allow that, mount by hand and put `app.use(oauth.errorHandler)` at the
very end yourself:

```ts
const oauth = createShopifyMcpOAuth(config);
app.use(oauth.router);
app.post("/mcp", oauth.requireAuth, myExistingMcpHandler);
// ... every other route ...
app.use(oauth.errorHandler); // LAST
```

### Where the endpoints land

The router mounts at the app root and claims these paths:

```
GET  /.well-known/oauth-protected-resource[/mcp]
GET  /.well-known/oauth-authorization-server[/mcp]
GET  /.well-known/openid-configuration[/mcp]
GET  /authorize
POST /token
POST /register
POST /revoke
GET  /oauth/shopify-callback
GET  /.well-known/openai-apps-challenge   (only if openaiAppsChallengeToken is set)
```

If your server already serves any of those, mount the router under a prefix — but then `host` must
include that prefix too, since every issued URL derives from it, and MCP clients look for
`/.well-known/...` at the **origin** root. In practice, run the MCP server as its own process or
subdomain rather than nesting it inside an existing app.

## 6. Keeping a credential scheme you already have

Most existing servers authenticate with a personal access token the merchant pastes in. You usually
want to keep accepting those while OAuth rolls out.

`requireAuth` can't be composed for this — it answers the request itself on failure, so nothing
runs after it. Use `authenticate` and `challenge`, which are the same logic with the response
decision left to you:

```ts
import type { RequestHandler } from "express";
import type { ShopifyMcpOAuth } from "shopify-mcp-oauth";

export function createMcpAuth(oauth: ShopifyMcpOAuth): RequestHandler {
  return async (req, res, next) => {
    try {
      // Your own scheme first: it must not shadow the OAuth path, so it should return null (not
      // answer) for anything that isn't recognisably one of its own tokens.
      const pat = await authenticatePersonalAccessToken(req);
      if (pat) {
        req.mcp = pat;
        return next();
      }

      const result = await oauth.authenticate(req);
      if (!result.ok) return oauth.challenge(res, result.reason);

      req.mcp = result.context;
      next();
    } catch (err) {
      next(err); // a storage outage is a 500, not "log in again"
    }
  };
}
```

Then `app.post("/mcp", createMcpAuth(oauth), handler)` in place of `oauth.requireAuth`.

Two things to keep straight:

- **`challenge` is not optional decoration.** The `WWW-Authenticate` header it writes is how a
  client that has never seen your server discovers where to log in (RFC 9728). A bare
  `res.sendStatus(401)` in its place strands the client with no way forward.
- **Order matters for audience enforcement.** Only `authenticate` checks the RFC 8707 `resource`
  binding. If your own scheme would also accept an OAuth-issued token, it shadows that check.

## 7. The install gate

After Shopify's bounce succeeds, the package looks the shop up via `findShopByDomain` and refuses
with 403 if it misses.

Be precise about what that checks. Reaching this point means the app **is** installed on the shop —
Shopify grants it on approval, so a merchant who wasn't a customer a moment ago is one now. What it
does not mean is that **your app has any record of it**: the grant landed on this server's
`/oauth/shopify-callback`, and the package discards the Shopify token rather than persisting it, so
nothing your own install flow writes gets written — no offline session (all the Shopify app template
stores), no shop row if you keep one, no billing, no webhooks, no `afterAuth`.

Without the gate that merchant gets tool access anyway, skipping your real install, against a shop
your app has never heard of. So it asks "does my app already know this shop", not "did Shopify grant
the app".

A miss still isn't always "not a customer". Shopify's managed install grants the app without the
merchant ever opening it, so if your record is written when they first open the embedded app, a
merchant who installed and went straight to an MCP client has nothing yet — and telling them to
install an app they already installed is a dead end.

`onShopNotFound` runs at exactly that point, holding the access token just exchanged for that shop:

```ts
onShopNotFound: async ({ domain, accessToken }) => {
  await registerShop(domain, accessToken); // store the offline session; run your own install work
  return storage.findShopByDomain(domain); // null keeps the 403
};
```

For a template-shaped app that's usually just storing the offline session — what your own callback
would have stored, which is why the token is handed over. Apps holding more of their own state do
that here too.

Returning a shop admits the merchant, so this hook *is* the gate now — do the work your install
would have done, and return `null` (or throw, for a 500) if it fails.

Return the shop your write actually produced, never one you assemble by hand. The `id` must be the
same id `findShopByDomain` will return for this domain from then on — every authenticated request
re-resolves the shop by domain and compares that row's id against the one baked into the token. An
id that lookup won't produce makes the login succeed and every subsequent tool call answer 401,
which an MCP client treats as "log in again", so it re-runs the flow and loops. The `domain` must
match the one passed in as well; a mismatch has the callback refuse the login rather than hand this
merchant a token scoped to someone else's store.

Omit the hook and you get the strict default. `allowAnyShop()` removes the gate entirely; only
reach for it if your app genuinely keeps no per-shop record at all.

## Gotchas worth knowing before you hit them

**`req.mcp` is typed globally, and `tokenId` is a string.** Importing anything from this package
augments `Express.Request` with `mcp?: McpAuthContext` across your whole project. If you want a
narrower type of your own, **extend** it — don't redeclare the property:

```ts
// Good: narrows shopId and adds a field, stays assignable to McpAuthContext.
export interface MyMcpContext extends McpAuthContext {
  shopId: number;
  authMethod: "oauth" | "pat";
}
```

```ts
// Bad: an incompatible re-declaration of `mcp` collapses to `never` at every use site,
// producing "Type 'number' is not assignable to type 'never'" far from the cause.
type MyRequest = Omit<Request, "mcp"> & { mcp?: { tokenId: number } };
```

`tokenId` is deliberately an opaque `string`, because an adapter may key tokens by UUID, BIGINT, or
ULID. If yours is a numeric foreign key, convert at the one place that writes it, not everywhere.

**`host` must match the request's origin exactly.** Token audiences, discovery documents, and the
redirect URI are all derived from it. A mismatch shows up as a login that completes and then 401s.

**Discovery must be reachable unauthenticated.** If your app has a global auth middleware, mount the
OAuth router above it, or exempt the `.well-known` paths. Clients read those before they have a
token, by definition.

## Verifying it works

Before wiring a real MCP client, four curls:

```bash
# 1. Resource metadata — must name your host, unauthenticated.
curl -s $HOST/.well-known/oauth-protected-resource | jq

# 2. Authorization server metadata — must list authorization_endpoint, token_endpoint, S256.
curl -s $HOST/.well-known/oauth-authorization-server | jq

# 3. An unauthenticated MCP call — 401, and the header must point back at (1).
curl -sD- -o/dev/null -X POST $HOST/mcp

# 4. Malformed JSON — a JSON error object, NOT an HTML stack trace.
#    HTML here means the error handler isn't mounted last (step 5).
curl -s -X POST $HOST/mcp -H 'Content-Type: application/json' -d '{ not json'
```

Then the real thing:

```bash
claude mcp add --transport http my-mcp https://<your-host>/mcp
```

The first tool call opens a browser at Shopify's shop picker. Approve, and the client is connected.
