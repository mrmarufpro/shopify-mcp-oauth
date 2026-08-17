# basic-server

The smallest MCP server that uses [`shopify-mcp-oauth`](../../packages/shopify-mcp-oauth): a merchant
logs in through Shopify from their MCP client, and the tools know which store is calling.

Three files:

| File           | What it does                                                |
| -------------- | ----------------------------------------------------------- |
| `src/index.ts` | Reads `.env`, starts the server                             |
| `src/app.ts`   | Express + `mountShopifyMcpOAuth` + the `POST /mcp` endpoint |
| `src/tools.ts` | The tools — `whoami` and `echo`. Add yours here             |

Storage is in-memory, so tokens are lost on restart. That is the only thing standing between this
and something you could deploy.

## Run it

You need Node ≥ 20.6, a Shopify Partner app, and a public HTTPS tunnel — MCP clients and Shopify
both have to reach this server.

**1. Install and configure.**

```bash
pnpm install
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # OAUTH_STATE_SECRET
```

**2. Start a tunnel** and copy the HTTPS URL it prints:

```bash
cloudflared tunnel --url http://localhost:3000   # or: ngrok http 3000
```

**3. Point the Partner app at it.** In the Partner dashboard set:

- App URL: `https://<your-tunnel>`
- Allowed redirection URL: `https://<your-tunnel>/oauth/shopify-callback`

The redirection URL has to match exactly. A mismatch shows up as Shopify's own error page during
login, before this server is ever reached.

**4. Fill in `.env`** — `MCP_HOST` is the tunnel URL, `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`
come from the Partner dashboard.

**5. Go.**

```bash
pnpm dev
claude mcp add --transport http my-mcp https://<your-tunnel>/mcp
```

The client opens Shopify's shop picker. Pick your development store, approve, and the browser hands
a token back to the client. Then ask it to call `whoami`.

## What to change before this is real

**Storage.** `memoryStorage()` keeps clients and tokens in this process — they vanish on restart,
and a second instance cannot see them, so login fails intermittently the moment you run more than
one. Swap it for `prismaStorage(prisma)` (or your own `OAuthStorage`) and pass a shared `cache` such
as `redisCache`. See [storage adapters](../../docs/storage-adapters.md).

**The install gate.** `allowAnyShop()` hands a token to any merchant who completes Shopify's login.
That is fine here because this example keeps no per-shop record at all, but a real app has one — an
offline session, billing, webhooks — and should refuse a merchant it has never installed for:

```ts
findShopByDomain: shopifySessionStorage(sessionStorage),   // or your own shop table
```

With that in place a merchant with no record gets a plain-text 403 from the callback. Shopify grants
the app on approval, so they really did install it; what is missing is your own record of them. Supply
`onShopNotFound` to write that record right there in the callback instead of refusing.

## Adding a tool

Add a `server.registerTool(...)` call in `src/tools.ts`. `auth.shopDomain` and `auth.shopId` name the
store, and `auth.tokenId` names the grant. Whatever you return from the handler goes straight to the
calling agent, so redact anything sensitive before returning it.
