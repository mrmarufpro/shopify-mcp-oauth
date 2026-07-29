# basic-server

A minimal MCP server for a Shopify app, with OAuth login handled by
[`shopify-mcp-oauth`](../../packages/shopify-mcp-oauth). Two demo tools: `whoami` returns the calling
shop's domain, `echo` returns its input. No Admin API calls — this example is about authentication.

## What you need first

- Node ≥ 20, pnpm, Docker (for Postgres)
- A Shopify Partner app and a development store
- A public HTTPS tunnel — MCP clients and Shopify both need to reach this server

## Setup

**1. Create a Partner app.** In the Shopify Partner dashboard, create an app and copy its API key and
API secret key.

**2. Start a tunnel.** Either works:

```bash
cloudflared tunnel --url http://localhost:3000
# or
ngrok http 3000
```

Copy the HTTPS URL it prints.

**3. Configure the app URLs.** In the Partner dashboard, set:

- App URL: `https://<your-tunnel>`
- Allowed redirection URL: `https://<your-tunnel>/oauth/shopify-callback`

The redirection URL must match exactly. A mismatch shows up as Shopify's own error page during login,
before this server is ever reached.

**4. Fill in the environment.**

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # OAUTH_STATE_SECRET
```

Set `MCP_HOST` to the tunnel URL, `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` from step 1, and
`DEMO_SHOP_DOMAIN` to your development store's domain (the same format as `your-store.myshopify.com`).

**5. Start the database, migrate, and seed.**

```bash
docker compose up -d
pnpm db:migrate
pnpm db:seed
```

**6. Run it.**

```bash
pnpm dev
```

## Connect a client

```bash
claude mcp add --transport http my-mcp https://<your-tunnel>/mcp
```

The client opens a browser at Shopify's shop picker. Pick the development store from step 4, approve,
and the browser returns to the client with a token. Then ask it to call `whoami`.

## The one error everybody hits

Pick a store in Shopify's picker that has no seeded session, approve the install screen, and the
callback answers with a plain-text `403`:

```
your-store.myshopify.com has not installed this app. Install it first, then connect again.
```

That's not a bug — it means no offline session exists for that shop. The install gate is deliberate:
completing Shopify's flow does **not** prove the app was installed beforehand — Shopify installs it on
approval — so without this check any merchant on Shopify could mint a token for your server.

Fix it by picking the store you seeded, or by seeding the store you picked:

```bash
DEMO_SHOP_DOMAIN=your-store.myshopify.com pnpm db:seed
```

In a real app the row already exists, written by your install flow.

## How it fits together

```
POST /mcp
  └─ oauth.requireAuth          ← bearer token → req.mcp = { shopId, shopDomain, tokenId }
      └─ createMcpHandler       ← fresh McpServer + stateless transport per request
          └─ runWithMcpContext  ← AsyncLocalStorage carrying the shop
              └─ withAuditLog   ← validate, time, log, shape errors
                  └─ your tool  ← reads ctx.auth.shopDomain
```

`AsyncLocalStorage` is not decoration. The MCP SDK hands a tool callback `extra.requestInfo`, which
carries headers only — never the Express request — so without it a tool cannot tell which shop is
calling. Most people discover this after their first tool answers for the wrong store.

## Storage

`src/storage.ts` wires three things:

```ts
export const sessionStorage = new PrismaSessionStorage(prisma);

export const storage: OAuthStorage = {
  ...prismaStorage(prisma), // clients and tokens
  findShopByDomain: shopifySessionStorage(sessionStorage), // the install gate
};

export const auditSink = createPrismaAuditSink(prisma);
```

`findShopByDomain` binds to Shopify's own `SessionStorage` interface rather than to a table, so
swapping `PrismaSessionStorage` for `RedisSessionStorage`, `MongoDBSessionStorage`, or any other
official adapter changes that one line and nothing else.

If your app has its own shop table instead, map it:

```ts
prismaStorage(prisma, { shop: { model: "store", domainField: "myshopifyDomain", idField: "id" } });
```

## Adding a tool

Copy `src/tools/echo.ts`, change the schema and handler, and register it in `src/tools/index.ts`.
`withAuditLog` gives you input validation, timing, one audit row per call, and MCP-shaped errors.
Its optional `narrate` hook appends a line to successful results — useful if you want the calling
agent to credit your app by name.

## Notes

- The example uses Prisma 6 because `@shopify/shopify-app-session-storage-prisma@9` requires it.
- The transport is stateless: no session IDs, no `GET`/`DELETE` handlers, any instance serves any
  request. Tools that need to hold state across calls would need session-ful mode instead.
- `prisma/migrations/0_init` was generated with `prisma migrate diff`, so cloning this repository
  never requires a running database.
