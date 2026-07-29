# shopify-mcp — Design Spec

**Date:** 2026-07-27
**Status:** approved, not yet implemented
**Origin:** extracted and generalized from a private production Shopify app's OAuth implementation and its internal engineering guide.

---

## 1. Purpose

Give any Shopify app developer a working starting point for an MCP server with OAuth 2.1 login, where
the merchant proves shop ownership through Shopify rather than through a copy-pasted token.

The hard part of building an MCP server for a Shopify app is not the tools — it is the auth. The MCP
spec (2025-11-25) requires the server to act as **both** an OAuth Resource Server and an OAuth
Authorization Server, support PKCE, support two different client-identification schemes (CIMD and
DCR), and expose six discovery documents that different clients look for in different places. Getting
that wrong means Claude Code, VSCode, Cursor, and ChatGPT each fail in a different, silent way.

This project ships that layer as a library, plus a runnable example that shows how to mount it.

### Goals

- A published npm package that handles the entire OAuth surface for a Shopify-app MCP server.
- Storage-agnostic: the package never assumes an ORM or a database.
- A `npx create-shopify-mcp my-mcp` scaffolder that produces a running server in one command.
- Tests that pass on a fresh clone with no Docker and no database.
- Documentation aimed at someone who has never read the MCP auth spec.

### Non-goals

- Not a Shopify app framework. It does not handle install, billing, webhooks, or the embedded admin UI.
- Not an MCP transport library. The package stops at authentication; the example owns MCP wiring.
- Not a merchant-facing product. No consent UI of our own — Shopify's shop picker is the consent step.

---

## 2. Repository layout

Repo: `~/works/open_source_projects/shopify-mcp`, published to GitHub as `shopify-mcp`.

```
shopify-mcp/
  packages/
    shopify-mcp-oauth/          npm: shopify-mcp-oauth
    create-shopify-mcp/         npm: create-shopify-mcp
  examples/
    basic-server/               the demo AND the CLI template
  docs/
    storage-adapters.md
  .github/workflows/ci.yml
  pnpm-workspace.yaml
  README.md
  LICENSE                       MIT
```

Fresh git history. Nothing is imported from the source app's repo except code that has been rewritten
to remove app-specific coupling (see §8).

Note: the npm name `shopify-mcp` is already taken by an unrelated package. The GitHub repo keeps the
short name; the published packages are `shopify-mcp-oauth` and `create-shopify-mcp`.

---

## 3. Package: `shopify-mcp-oauth`

### 3.1 Public API

```ts
import {
  createShopifyMcpOAuth,
  prismaStorage,
  memoryStorage,
  shopifySessionStorage,
  allowAnyShop,
  memoryCache,
  redisCache,
  runStorageContractTests,
  type OAuthStorage,
  type CacheStore,
} from "shopify-mcp-oauth";

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
  tokenTtl: { access: 3600, refresh: 2_592_000 },
  openaiAppsChallengeToken: process.env.OPENAI_APPS_CHALLENGE_TOKEN ?? null,
});

app.use(oauth.router);
app.post("/mcp", oauth.requireAuth, myMcpHandler);
```

### 3.2 Config

| Field | Required | Default | Notes |
|---|---|---|---|
| `host` | yes | — | Public origin, HTTPS in production, no trailing slash. Every issued URL derives from this. |
| `shopify.apiKey` / `apiSecret` | yes | — | The Shopify app's credentials. Same app the merchant installed. |
| `shopify.scopes` | yes | — | Comma-separated. Must match the installed app's scopes or Shopify re-prompts. |
| `stateSecret` | yes | — | HS256 signing key for the state JWT. ≥32 bytes. |
| `storage` | yes | — | An `OAuthStorage`. |
| `cache` | no | `memoryCache()` | Holds auth codes and CIMD documents. |
| `tokenTtl.access` | no | `3600` | Seconds. |
| `tokenTtl.refresh` | no | `2592000` (30d) | Seconds. |
| `openaiAppsChallengeToken` | no | `null` | Only needed to list the server as a ChatGPT app. Route is omitted when null. |
| `registerRateLimit` | no | `{ limit: 20, windowMs: 3600000 }` | DCR is unauthenticated; this endpoint is a spam target. |
| `logger` | no | `console` | Anything with `info` / `warn` / `error`. |

Config is validated at construction time with Zod. A missing or malformed value throws immediately
with a message naming the field — never at the first request.

### 3.3 Returned object

```ts
interface ShopifyMcpOAuth {
  router: Router;              // all OAuth + discovery routes
  requireAuth: RequestHandler; // Resource Server bearer check
}
```

`requireAuth` sets `req.mcp = { shopId, shopDomain, tokenId }` on success. On failure it returns 401
with an RFC 9728 `WWW-Authenticate` header pointing at the protected-resource metadata document —
that header is how compliant clients discover where to start the login flow.

### 3.4 Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/.well-known/oauth-authorization-server` | AS metadata (RFC 8414) |
| GET | `/.well-known/oauth-authorization-server/mcp` | same, path-suffixed variant |
| GET | `/.well-known/openid-configuration` | same document, OIDC-shaped |
| GET | `/.well-known/openid-configuration/mcp` | same, path-suffixed variant |
| GET | `/.well-known/oauth-protected-resource` | RS metadata (RFC 9728) |
| GET | `/.well-known/oauth-protected-resource/mcp` | same, path-suffixed variant |
| GET | `/authorize` | validates client + PKCE, redirects to Shopify's shop picker |
| GET | `/oauth/shopify-callback` | HMAC-verified; exchanges Shopify's code, issues ours |
| POST | `/register` | Dynamic Client Registration (RFC 7591), rate-limited |
| POST | `/token` | `authorization_code` and `refresh_token` grants |
| POST | `/revoke` | RFC 7009 |
| GET | `/.well-known/openai-apps-challenge` | optional; only mounted when a token is configured |

The four redundant discovery paths are deliberate. Different clients probe different URLs, and a 404
on the one a client happens to check produces an unhelpful "server does not support OAuth" error.

### 3.5 Login flow

```
1.  Client fetches /.well-known/oauth-protected-resource (or gets pointed there by a 401).
2.  Client identifies itself, one of two ways:
      CIMD — client_id is an HTTPS URL serving a client-metadata JSON document.
             We fetch it, validate it, cache it 1h. No database row, ever.
      DCR  — client POSTs /register, we persist a client row and return a client_id.
3.  Client opens a browser at:
      GET /authorize?client_id=…&redirect_uri=…&code_challenge=…&code_challenge_method=S256
                    &state=…&resource=https://mcp.example.com/mcp
4.  AS validates: resource matches ours exactly, client resolves, redirect_uri is registered
    for that client, PKCE method is S256.
5.  AS signs a 10-minute state JWT carrying { client_id, redirect_uri, client_state,
    code_challenge, code_challenge_method, resource, nonce } and redirects the browser to
    Shopify's shop picker:
      https://admin.shopify.com/?no_redirect=true
        &redirect=/oauth/authorize?client_id=<shopify app>&redirect_uri=<host>/oauth/shopify-callback
                                  &scope=<scopes>&state=<state JWT>
6.  Merchant picks a store and approves. Shopify redirects to /oauth/shopify-callback.
7.  Callback verifies Shopify's HMAC, verifies the state JWT, exchanges Shopify's code for a
    Shopify access token — proof the merchant controls that shop.
8.  Callback looks the shop up by domain. Not found -> 403 shop_not_installed (see §3.7).
    The Shopify access token is discarded; we only needed it as proof.
9.  Callback mints a 60-second authorization code in the cache, keyed to the shop, client,
    redirect_uri, and code_challenge; redirects the browser back to the client's redirect_uri
    with ?code=…&state=<the client's original state>.
10. Client POSTs /token with the code and its PKCE verifier. We verify the challenge, delete
    the code, and issue { access_token, refresh_token, expires_in, token_type: "Bearer" }.
11. Client calls POST /mcp with Authorization: Bearer <access_token>.
```

The merchant's browser is the only participant that talks to Shopify during consent. Our one
server-to-server Shopify call is the token exchange in step 7.

### 3.6 Storage interface

```ts
interface OAuthStorage {
  findClient(clientId: string): Promise<OAuthClient | null>;
  createClient(client: NewOAuthClient): Promise<OAuthClient>;
  upsertClient(client: NewOAuthClient): Promise<OAuthClient>;

  createToken(token: NewToken): Promise<StoredToken>;
  findTokenByAccessHash(hash: string): Promise<StoredToken | null>;
  findTokenByRefreshHash(hash: string): Promise<StoredToken | null>;
  revokeToken(id: string): Promise<void>;
  touchToken(id: string, lastUsedAt: Date): Promise<void>;

  findShopByDomain(domain: string): Promise<ShopRef | null>;
}

interface OAuthClient {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
  clientSecretHash: string | null;
}

interface StoredToken {
  id: string;
  shopId: string | number;
  shopDomain: string; // denormalized: the resource server names the shop without a reverse lookup
  clientId: string;
  accessTokenHash: string;
  refreshTokenHash: string | null;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date | null;
  scope: string | null;
  resource: string | null;
  revokedAt: Date | null;
}

interface ShopRef {
  id: string | number; // whatever the app keys shop-scoped data by — often the domain itself
  domain: string;
}

interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}
```

Anything matching these shapes works — Drizzle, Sequelize, TypeORM, Mongo, raw SQL. The package
exports `runStorageContractTests(makeStorage)`, a Vitest suite that a custom adapter can run against
itself to prove it satisfies the contract (expiry filtering, revocation, hash uniqueness, null
handling). `docs/storage-adapters.md` walks through writing one.

Shipped adapters:

| Adapter | Use |
|---|---|
| `prismaStorage(prisma, opts)` | Clients and tokens on Prisma. `opts.shop` optionally maps a custom shop table. |
| `memoryStorage()` | Tests and local exploration. |
| `shopifySessionStorage(sessionStorage)` | Shop lookup against any `@shopify/shopify-app-session-storage` adapter. |
| `allowAnyShop()` | Explicit opt-out of the install gate. |
| `memoryCache()` | Default cache. |
| `redisCache(client)` | Production cache. |

A full Redis `OAuthStorage` is deliberately out of scope for v0. A Redis-only app writes ~120 lines
against the interface and proves it with `runStorageContractTests`; adding a bundled adapter later is
not a breaking change.

### 3.6.1 Shop identity

`findShopByDomain` is the one method that touches the adopter's own data model, and no two apps model
it the same way. A table named `Shop` is **not** the common case — apps generated by the Shopify CLI
have a `Session` table from `@shopify/shopify-app-session-storage-*`, and that session data may live
in Redis, MongoDB, DynamoDB, or Cloudflare KV rather than SQL.

So the primary path binds to Shopify's own interface, not to a schema. `SessionStorage` requires
`findSessionsByShop(shop): Promise<Session[]>`, which every official adapter implements:

```ts
findShopByDomain: shopifySessionStorage(sessionStorage)
// -> findSessionsByShop(domain), pick an offline session holding an accessToken, else null
// -> ShopRef.id is the shop domain
```

Swapping `PrismaSessionStorage` for `RedisSessionStorage` changes one line in the adopter's app and
nothing in ours.

Three supported ways to supply it, in order of preference:

| Situation | Wiring |
|---|---|
| App uses `@shopify/shopify-app-*` (most apps) | `shopifySessionStorage(sessionStorage)` |
| App has its own shop table | `prismaStorage(prisma, { shop: { model: "store", domainField: "myshopifyDomain", idField: "id" } })`, or a hand-written function |
| App has no per-shop record at all | `allowAnyShop()` |

Enforced by types, not documentation: `prismaStorage(prisma)` returns
`Omit<OAuthStorage, "findShopByDomain">`, so a config missing the lookup fails to compile. Passing
`{ shop: … }` returns the complete `OAuthStorage`. There is no silent default.

**The memory cache is single-process only.** Auth codes live in the cache, so on a multi-instance
deployment a login started on one instance fails on another — the code is not found and the client
reports an opaque `invalid_grant`. The README states this in the quickstart, not in a footnote.

### 3.7 Unknown shops

If `findShopByDomain` returns null after a successful Shopify bounce, the callback fails with 403
`shop_not_installed` and a plain-text message telling the merchant to install the app first. The
package never creates shop rows: a real install involves webhook registration, billing setup, and
app-specific defaults that the package cannot know about, and a half-created shop row is worse than a
clear error.

This check is the only gate that exists. Completing the Shopify bounce does **not** prove the app was
already installed — Shopify's authorize flow installs the app on approval if it was not. Without the
lookup, any merchant on Shopify could mint a token for the server. `allowAnyShop()` therefore has to
be passed explicitly, and the docs say plainly what it removes.

### 3.8 Security decisions

- **Tokens are stored as SHA-256 hashes.** A database leak does not yield usable bearer tokens.
- **PKCE S256 only.** `plain` is rejected. No PKCE, no authorization.
- **Redirect URIs match exactly** (scheme, host, port, path), except that `localhost` and `127.0.0.1`
  ignore the port, which RFC 8252 requires for native clients that bind an ephemeral port.
- **CIMD fetches are SSRF-guarded:** HTTPS only, no private or loopback address ranges, no redirects
  followed, response size capped, hard timeout, strict JSON shape validation, and the document's
  declared `redirect_uris` must contain the one being requested.
- **The Shopify callback verifies Shopify's HMAC** before anything else runs.
- **State JWTs are short-lived** (10 minutes) and carry a nonce.
- **Authorization codes are single-use** and deleted at redemption; a replay finds nothing.
- **`/register` is rate-limited** because DCR is unauthenticated by definition.
- **Refresh rotates**: redeeming a refresh token revokes it and issues a new pair.

---

## 4. Example app (`examples/basic-server`)

Deliberately thin. Every line is about auth; there is nothing to skim past.

```
examples/basic-server/
  src/
    mcp/
      transport.ts       stateless streamable-HTTP handler
      context.ts         AsyncLocalStorage shop context
      server.ts          McpServer construction + tool registration
      withAuditLog.ts    tool wrapper: validate, time, log, shape errors
    tools/
      whoami.ts          returns the calling shop's domain
      echo.ts            returns its input
    storage.ts           prisma or memory, plus shop lookup via SessionStorage
    index.ts             express app, mounts oauth.router and POST /mcp
  prisma/
    schema.prisma
    migrations/
    seed.ts
  docker-compose.yml     postgres
  .env.example
  README.md              Shopify Partner app + tunnel setup
```

### 4.1 The MCP runner (`src/mcp/`)

This is the code the package deliberately does not own. It is heavily commented, because it encodes
one non-obvious constraint:

> The MCP SDK passes tool callbacks an `extra.requestInfo` that carries **headers only** — not the
> Express request. So an authenticated tool cannot see which shop is calling.

The fix is `AsyncLocalStorage`: `transport.ts` wraps both `server.connect(transport)` and
`transport.handleRequest(...)` in `runWithShop(req.mcp, ...)`, and tools read `getShopContext()`.
Most people writing this from scratch discover the problem only after their first tool returns data
for the wrong store, or for no store at all.

`transport.ts` is stateless: a fresh `McpServer` and `StreamableHTTPServerTransport({
sessionIdGenerator: undefined })` per POST, both closed on `res.close`. Session-ful mode needs a
session store plus GET and DELETE handlers; stateless is the right default for a tool server and the
example says why.

### 4.2 `withAuditLog`

Ships in the template, not the package, because it depends on the shop context that lives here and
because the log row's shape is opinionated enough that every adopter edits it.

```ts
export const whoamiTool = {
  name: "whoami",
  config: { description: "…", inputSchema: whoamiSchema },
  callback: withAuditLog({
    toolName: "whoami",
    schema: whoamiSchema,
    handler: async (input, ctx) => { … },
  }),
};
```

It wraps a handler to:

1. validate input with the Zod schema, returning `VALIDATION_FAILED` on a mismatch;
2. measure duration;
3. write one `McpAuditLog` row in a `finally` block — best-effort, never fails the tool call;
4. convert a thrown `McpToolError` into MCP's `{ isError: true, content }` shape;
5. optionally append a narration line via a `narrate?: (toolName: string) => string` hook. Off by
   default. The source app uses this to make the client agent credit the app by name when
   summarizing a result; it is app-specific, so the boilerplate ships the hook and no default string.

### 4.3 Prisma schema

The `Session` model is copied verbatim from what `shopify app init` generates, so anyone arriving
from the official template recognizes it and needs no mapping config.

```prisma
model Session {
  id            String    @id
  shop          String
  state         String
  isOnline      Boolean   @default(false)
  scope         String?
  expires       DateTime?
  accessToken   String
  userId        BigInt?
  firstName     String?
  lastName      String?
  email         String?
  accountOwner  Boolean   @default(false)
  locale        String?
  collaborator  Boolean?  @default(false)
  emailVerified Boolean?  @default(false)
}

model McpOAuthClient {
  id                      String   @id @default(cuid())
  clientId                String   @unique
  clientName              String?
  clientSecretHash        String?
  redirectUris            String[]
  grantTypes              String[]
  tokenEndpointAuthMethod String   @default("none")
  createdAt               DateTime @default(now())
}

model McpOAuthToken {
  id                    String    @id @default(cuid())
  shopId                String    // whatever findShopByDomain returned as the shop's id
  shopDomain            String    // denormalized so the resource server can name the shop
  clientId              String
  accessTokenHash       String    @unique
  refreshTokenHash      String?   @unique
  accessTokenExpiresAt  DateTime
  refreshTokenExpiresAt DateTime?
  scope                 String?
  resource              String?
  revokedAt             DateTime?
  lastUsedAt            DateTime?
  createdAt             DateTime  @default(now())

  @@index([shopId])
}

model McpAuditLog {
  id           String   @id @default(cuid())
  shopId       String
  mcpTokenId   String?
  toolName     String
  inputParams  Json
  output       Json?
  mcpClient    String?
  status       String
  errorMessage String?
  durationMs   Int
  createdAt    DateTime @default(now())

  @@index([shopId, createdAt])
}
```

`McpOAuthToken` deliberately carries no foreign key to `Session`: a shop has many sessions (online
and offline, one per staff member), so the token keys on the shop domain instead. That also keeps the
model unchanged when an adopter moves sessions to Redis, where there is no row to point at.

Wiring, with the swap the template is built to demonstrate:

```ts
// storage.ts
const sessionStorage = new PrismaSessionStorage(prisma);
// swap for `new RedisSessionStorage(redis)` — nothing below changes

export const storage: OAuthStorage = {
  ...prismaStorage(prisma),
  findShopByDomain: shopifySessionStorage(sessionStorage),
};
```

### 4.4 Seeding

`pnpm db:seed` inserts one **offline** `Session` row for `DEMO_SHOP_DOMAIN` with a placeholder access
token — enough for `findSessionsByShop` to return it, which is all the gate checks. This must be the
development store the tester actually picks in Shopify's shop picker; otherwise the callback
correctly returns `shop_not_installed` and the first run looks like a bug. The example README leads
with this.

In the in-memory variant there is no seed script: `storage.ts` constructs a `MemorySessionStorage`
and stores the same demo session at boot.

### 4.5 Example README

Covers, in order: create a Shopify Partner app, copy the API key and secret, start a tunnel
(`cloudflared` or `ngrok`), set `MCP_HOST` to the tunnel URL, add the callback URL to the app's
allowed redirection URLs, seed the demo shop, run, then connect with
`claude mcp add --transport http my-mcp https://<tunnel>/mcp`.

---

## 5. CLI: `create-shopify-mcp`

```
npx create-shopify-mcp my-mcp

? Storage  › Prisma + Postgres
            In-memory (try it out)

✓ created my-mcp
  cd my-mcp && pnpm install
  cp .env.example .env      # add your Shopify API key and secret
  docker compose up -d
  pnpm db:migrate && pnpm db:seed
  pnpm dev
```

Behaviour:

- Copies the bundled template into the target directory, refusing to overwrite a non-empty one.
- Rewrites `package.json`: name from the directory argument, workspace dependency replaced with the
  published `shopify-mcp-oauth` version.
- On **in-memory**, removes `prisma/`, `docker-compose.yml`, and the db scripts, and swaps
  `storage.ts` for the memory variant (`memoryStorage()` plus a `MemorySessionStorage` seeded with
  the demo shop). Prints a warning that tokens are lost on restart and that this mode is
  single-process.
- Initializes a git repository with one commit.
- Prints the next-step block above, adjusted for the chosen storage.

**Template sourcing.** The template is not a second copy. A `prepack` script copies
`examples/basic-server` into `packages/create-shopify-mcp/templates/default` (gitignored), applying a
manifest that excludes `node_modules`, build output, and lockfiles, and rewrites the workspace
dependency. CI asserts the copy step runs clean, so the example and the template cannot drift.

---

## 6. Tests

Vitest across the workspace. `pnpm test` on a fresh clone passes with no Docker, no Postgres, no
Redis — everything runs against `memoryStorage` + `memoryCache`.

Ported from the source app (~14 files), rewritten against the storage interface:

- services: `pkce`, `stateJwt`, `cimdResolver` (including the SSRF rejection cases), `clientStore`,
  `tokenStore`, `tokens`, `redirectUri`
- controllers: `authorize`, `token`, `register`, `revoke`, `metadata`, `shopifyCallback`
- middleware: `requireAuth`, `verifyShopifyHmac`, `rateLimit`

Added:

- `runStorageContractTests` run against both `memoryStorage` and `prismaStorage` (the latter behind
  an opt-in `DATABASE_URL`, skipped in the default run).
- `shopifySessionStorage` against `MemorySessionStorage`: offline session found, online-only sessions
  rejected, a session with no access token rejected, no sessions at all → null.
- CLI: scaffold into a temp directory, assert both storage variants produce a tree that typechecks.

Test data follows readable-fixture rules: named constants (`const DEMO_SHOP = "demo.myshopify.com"`)
referenced from both setup and assertion, no scattered opaque literals, and no assertion on a factory
default.

---

## 7. CI, license, docs

- **CI:** GitHub Actions on push and PR — Node 20 and 22, pnpm, `typecheck` + `lint` + `test` +
  `build` + the template-copy check.
- **License:** MIT.
- **Docs:** `README.md` (what it is, quickstart, config table, one flow diagram, the multi-instance
  cache warning, security notes) and `docs/storage-adapters.md` (the interface, writing an adapter,
  running the contract tests). The deep debugging chapters from the source app's 50KB internal
  engineering guide are not ported.

---

## 8. What changed from the source app

| Source app | Here |
|---|---|
| Sequelize models imported directly | `OAuthStorage` calls |
| `env` module + `shopify.app*.toml` scope parsing at boot | explicit config object |
| `registerShopFromCallback` + queue dispatch on unknown shop | dropped; 403 `shop_not_installed` |
| Shop lookup hardcoded to a `shops` table | `findShopByDomain`, defaulting to Shopify's `SessionStorage` interface |
| PAT / HS256 JWT as a second auth path | dropped |
| `withAuditLog` writing to an app-specific audit table via app services | ported into the template against `McpAuditLog` |
| Hardcoded narration directive naming the app | optional `narrate` hook, no default |
| 43 production tools | 2 demo tools |
| Redis required | `CacheStore`, memory by default |

Kept in substance: PKCE, state JWT, CIMD resolver and its SSRF guards, DCR, the Shopify HMAC check,
the rate limiters, the six discovery routes, token hashing, refresh rotation.

### Scrub list

Before the first push, confirm none of the following survive anywhere in the tree, including tests,
fixtures, and comments: the app name and its domains, internal doc paths and ticket links, the
ChatGPT app submission manifest, third-party data-provider names, and any real API key, secret,
token, or store domain.

---

## 9. Build order

1. Workspace skeleton — pnpm workspace, TypeScript config, ESLint, Prettier, Vitest, CI, MIT license.
   Both packages build with `tsup` to ESM + CJS with type declarations, targeting Node ≥20;
   `shopify-mcp-oauth` keeps `express` and `zod` as peer dependencies so an adopter's versions win.
2. Package types and config validation — `OAuthStorage`, `CacheStore`, Zod config schema.
3. Adapters — `memoryStorage`, `memoryCache`, `redisCache`, then `prismaStorage`, plus
   `runStorageContractTests`.
4. Services — hashing, PKCE, state JWT, redirect-URI matching, CIMD resolver, client store, token
   store. Ported tests come with each.
5. Controllers and router — metadata, register, authorize, shopify-callback, token, revoke; then
   `requireAuth`.
6. Example app — Prisma schema, storage wiring, MCP runner, `withAuditLog`, two tools,
   docker-compose, seed, README.
7. CLI — prompts, copy, rewrite, git init, next steps; prepack template sourcing; scaffold tests.
8. Docs — root README and `docs/storage-adapters.md`.
9. Manual end-to-end pass against a real Partner app and dev store, connected from Claude Code, then
   from one other client (VSCode or Cursor) to shake out discovery-path assumptions.
10. Publish both packages, push the repo.

---

## 10. Risks

- **First-run friction.** Nothing can be tried without a Shopify Partner app and a public HTTPS
  tunnel. Mitigated by the in-memory scaffold and a README that front-loads the tunnel step, not
  eliminated.
- **Client compatibility.** Each MCP client interprets discovery slightly differently. Step 9 above
  tests two clients; others may surface gaps after release.
- **Memory-cache footgun.** Single-process auth-code storage breaks silently on a scaled deployment.
  Documented in the quickstart and in the CLI's post-scaffold output.
- **API churn before publish.** The package API is not frozen; the first releases should be `0.x` so
  breaking changes are expected rather than surprising.
