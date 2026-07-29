# examples/basic-server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the runnable example server that mounts `shopify-mcp-oauth`, owns the MCP runner the package deliberately does not ship, and doubles as the template `create-shopify-mcp` scaffolds.

**Architecture:** An Express app that mounts `oauth.router` for login and guards `POST /mcp` with `oauth.requireAuth`. Each `POST /mcp` builds a fresh `McpServer` + stateless `StreamableHTTPServerTransport`, and runs the whole transport chain inside an `AsyncLocalStorage` context carrying the authenticated shop — because the MCP SDK hands tool callbacks headers only, never the Express request. Two demo tools (`whoami`, `echo`) go through `withAuditLog`, which validates input, times the call, writes one audit row, and shapes errors.

**Tech Stack:** TypeScript (strict), Express 5, `@modelcontextprotocol/sdk` 1.29, Zod 3.25, Prisma 6, `@shopify/shopify-app-session-storage-{prisma,memory}`, Vitest, tsx.

This is **plan 2 of 3**. Plan 1 builds the `shopify-mcp-oauth` package and must be complete first. Plan 3 builds `create-shopify-mcp`, which copies this directory verbatim as its template — so every file here has to work both as a demo someone reads and as the starting point someone edits.

Spec: `docs/superpowers/specs/2026-07-27-shopify-mcp-oauth-boilerplate-design.md` §4.

## Global Constraints

- Node ≥ 20. `package.json` sets `"engines": { "node": ">=20" }`.
- TypeScript `strict: true`, inherited from `tsconfig.base.json`. The example is never compiled — `tsx` runs it and `tsc --noEmit` checks it.
- Test runner is **Vitest**. Never invoke Jest.
- **The package must be built before the example's tests run.** pnpm links `shopify-mcp-oauth` through its `exports` map, which points at `dist/`. Run `pnpm --filter shopify-mcp-oauth build` after any package change, and before `pnpm --filter basic-server test`.
- Imports of package subpaths carry the `.js` extension (`@modelcontextprotocol/sdk/server/mcp.js`) — Node's ESM resolver needs it. Relative imports omit extensions; `tsx` and Vitest resolve them.
- Prisma is pinned to `^6.19`, not 7: `@shopify/shopify-app-session-storage-prisma@9` peer-requires `prisma@^6.19` and `@prisma/client@^6.19`, and Prisma 7 additionally requires a driver adapter plus a generated-output path that the README would have to explain.
- Formatting: double quotes, 120 print width, 2-space indent, trailing comma `es5`.
- Comments are minimal: only where the *why* is non-obvious. The `AsyncLocalStorage` constraint in `transport.ts` is the one place where a longer comment earns its keep.
- Test data uses readable named constants (`const DEMO_SHOP = "demo.myshopify.com"`) referenced from both setup and assertion. Never assert on a factory default — pass the value as an explicit override next to the assertion.
- No app-specific names, no vendor names, no real credentials, no real store domains anywhere in the tree.

---

## File Structure

```
examples/basic-server/
  src/
    config.ts                 loadConfig() — env → typed config, validated with Zod
    audit.ts                  AuditEntry / AuditSink, prisma + console sinks
    demoSession.ts            buildDemoOfflineSession() — shared by the seed and the memory storage
    storage.ts                prisma variant: OAuthStorage + session storage + audit sink
    storage.memory.ts         in-memory variant, same three exports (the CLI swaps this in)
    storage.contract.test.ts  the package's storage contract suite against real Postgres, opt-in
    app.ts                    createApp(deps) — express wiring, testable without env or a DB
    index.ts                  reads env, picks storage, listens
    mcp/
      context.ts              AsyncLocalStorage carrying { auth, mcpClient, audit }
      errors.ts               McpToolError + the codes the demo tools use
      clientName.ts           classifyClient(userAgent)
      withAuditLog.ts         tool wrapper: validate, time, log, shape errors, optional narration
      server.ts               buildMcpServer() — McpServer construction
      transport.ts            createMcpHandler(deps) — stateless streamable HTTP per POST
    tools/
      whoami.ts               returns the calling shop's domain
      echo.ts                 returns its input
      index.ts                registerTools(server)
  prisma/
    schema.prisma
    migrations/0_init/migration.sql
    seed.ts
  docker-compose.yml
  .env.example
  package.json  tsconfig.json  vitest.config.ts
  README.md
```

This elaborates spec §4's tree in four places, each for a testability reason:

- `config.ts` — env parsing lives behind a pure function so it can be tested without a real environment.
- `app.ts` — the Express app is a factory taking its dependencies, so tests build one with memory storage while `index.ts` builds the real one.
- `audit.ts` + `demoSession.ts` — the audit sink is a value, not a global, so the memory variant can swap it; the demo session builder is shared by the Prisma seed and the memory boot rather than duplicated.
- `mcp/errors.ts` + `mcp/clientName.ts` — small units `withAuditLog` depends on, split so each has its own test.

Tests are co-located: `src/mcp/withAuditLog.test.ts` next to `src/mcp/withAuditLog.ts`.

---

## Locked Interfaces

Every task below consumes or produces from this set. Names here are authoritative — a later task using a different spelling is a bug.

```ts
// src/config.ts
export interface ExampleConfig {
  host: string;
  port: number;
  demoShopDomain: string;
  shopify: { apiKey: string; apiSecret: string; scopes: string };
  stateSecret: string;
}
export function loadConfig(environment?: Record<string, string | undefined>): ExampleConfig;
```

```ts
// src/audit.ts
export interface AuditEntry {
  shopId: string | number;
  shopDomain: string;
  mcpTokenId: string | null;
  toolName: string;
  inputParams: unknown;
  output: unknown;
  mcpClient: string | null;
  status: "success" | "error";
  errorMessage: string | null;
  durationMs: number;
}
export type AuditSink = (entry: AuditEntry) => Promise<void>;
export interface AuditPrismaClient {
  mcpAuditLog: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
}
export function createPrismaAuditSink(prisma: AuditPrismaClient): AuditSink;
export function createConsoleAuditSink(logger?: Pick<Console, "info">): AuditSink;
```

```ts
// src/demoSession.ts
export interface DemoOfflineSession {
  id: string;
  shop: string;
  state: string;
  isOnline: false;
  scope: string;
  accessToken: string;
}
export function buildDemoOfflineSession(shopDomain: string, scope: string): DemoOfflineSession;
```

```ts
// src/storage.ts and src/storage.memory.ts — the same three names, so index.ts is identical either way
export const storage: OAuthStorage;
export const sessionStorage: ShopifySessionStorageLike;
export const auditSink: AuditSink;
// storage.memory.ts additionally exports the factory the tests use:
export function createMemoryStorage(demoShopDomain: string): {
  storage: OAuthStorage;
  sessionStorage: ShopifySessionStorageLike;
  auditSink: AuditSink;
};
```

```ts
// src/mcp/context.ts
import type { McpAuthContext } from "shopify-mcp-oauth";
export interface McpRequestContext {
  auth: McpAuthContext;
  mcpClient: string;
  audit: AuditSink;
}
export function runWithMcpContext<T>(context: McpRequestContext, fn: () => Promise<T>): Promise<T>;
export function getMcpContext(): McpRequestContext | null;
```

```ts
// src/mcp/errors.ts
export const ERROR_CODES: {
  NOT_AUTHENTICATED: "NOT_AUTHENTICATED";
  VALIDATION_FAILED: "VALIDATION_FAILED";
  DOWNSTREAM_ERROR: "DOWNSTREAM_ERROR";
};
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
export class McpToolError extends Error {
  constructor(code: ErrorCode, message: string, details?: unknown);
  readonly code: ErrorCode;
  readonly details: unknown;
  toContent(): ToolResult & { isError: true };
}
```

```ts
// src/mcp/withAuditLog.ts
export interface ToolContext {
  auth: McpAuthContext;
  mcpClient: string;
}
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
export interface WithAuditLogOptions<TSchema extends z.ZodTypeAny> {
  toolName: string;
  schema: TSchema;
  handler: (input: z.infer<TSchema>, ctx: ToolContext) => Promise<ToolResult>;
  narrate?: (toolName: string) => string;
}
export function withAuditLog<TSchema extends z.ZodTypeAny>(
  options: WithAuditLogOptions<TSchema>
): (rawInput: unknown) => Promise<ToolResult>;
```

```ts
// src/mcp/transport.ts
export interface McpHandlerDeps {
  audit: AuditSink;
}
export function createMcpHandler(deps: McpHandlerDeps): RequestHandler;
```

```ts
// src/app.ts
export interface AppDeps {
  host: string;
  shopify: { apiKey: string; apiSecret: string; scopes: string };
  stateSecret: string;
  storage: OAuthStorage;
  audit: AuditSink;
  /** Test seam: the OAuth package uses this for Shopify's token exchange. */
  fetchImpl?: typeof fetch;
}
export function createApp(deps: AppDeps): Express;
```

---

## Task 1: Example workspace and environment config

**Files:**
- Create: `examples/basic-server/package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`
- Create: `examples/basic-server/src/config.ts`
- Test: `examples/basic-server/src/config.test.ts`

**Interfaces:**
- Consumes: nothing from plan 1 yet
- Produces: `loadConfig(environment?)` → `ExampleConfig`, and a workspace package named `basic-server`

- [ ] **Step 1: Write the failing test**

`examples/basic-server/src/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const VALID_ENVIRONMENT = {
  MCP_HOST: "https://mcp.example.com",
  SHOPIFY_API_KEY: "test-api-key",
  SHOPIFY_API_SECRET: "test-api-secret",
  SHOPIFY_SCOPES: "read_products",
  OAUTH_STATE_SECRET: "test-state-secret-at-least-32-bytes-long",
};

describe("loadConfig", () => {
  it("reads the Shopify credentials through", () => {
    const config = loadConfig({ ...VALID_ENVIRONMENT, SHOPIFY_SCOPES: "read_products,write_products" });
    expect(config.shopify).toEqual({
      apiKey: "test-api-key",
      apiSecret: "test-api-secret",
      scopes: "read_products,write_products",
    });
  });

  it("defaults the port to 3000", () => {
    expect(loadConfig(VALID_ENVIRONMENT).port).toBe(3000);
  });

  it("reads a port from the environment", () => {
    expect(loadConfig({ ...VALID_ENVIRONMENT, PORT: "4001" }).port).toBe(4001);
  });

  it("strips a trailing slash so issued URLs never double up", () => {
    const config = loadConfig({ ...VALID_ENVIRONMENT, MCP_HOST: "https://mcp.example.com/" });
    expect(config.host).toBe("https://mcp.example.com");
  });

  it("defaults the demo shop domain", () => {
    expect(loadConfig(VALID_ENVIRONMENT).demoShopDomain).toBe("demo.myshopify.com");
  });

  it("reads a demo shop domain from the environment", () => {
    const config = loadConfig({ ...VALID_ENVIRONMENT, DEMO_SHOP_DOMAIN: "other-store.myshopify.com" });
    expect(config.demoShopDomain).toBe("other-store.myshopify.com");
  });

  it("names the missing variable when a required one is absent", () => {
    const { SHOPIFY_API_SECRET: _absent, ...withoutSecret } = VALID_ENVIRONMENT;
    expect(() => loadConfig(withoutSecret)).toThrow(/SHOPIFY_API_SECRET/);
  });

  it("rejects a state secret shorter than 32 characters", () => {
    expect(() => loadConfig({ ...VALID_ENVIRONMENT, OAUTH_STATE_SECRET: "too-short" })).toThrow(
      /OAUTH_STATE_SECRET/
    );
  });

  it("rejects a host that is not a URL", () => {
    expect(() => loadConfig({ ...VALID_ENVIRONMENT, MCP_HOST: "mcp.example.com" })).toThrow(/MCP_HOST/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter basic-server test`
Expected: FAIL — the workspace package does not exist yet.

- [ ] **Step 3: Create the package files**

`examples/basic-server/package.json`:

```json
{
  "name": "basic-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "@shopify/shopify-api": "^13.1.0",
    "@shopify/shopify-app-session-storage": "^5.0.1",
    "@shopify/shopify-app-session-storage-memory": "^6.0.1",
    "express": "^5.2.1",
    "shopify-mcp-oauth": "workspace:*",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^22.0.0",
    "@types/supertest": "^6.0.2",
    "supertest": "^7.0.0",
    "tsx": "^4.23.1",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`examples/basic-server/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "declaration": false },
  "include": ["src", "prisma"]
}
```

`examples/basic-server/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

`examples/basic-server/.env.example`:

```
# Public HTTPS origin of this server — a tunnel URL in development (cloudflared, ngrok).
# Must match the app URL and allowed redirection URL configured in the Shopify Partner dashboard.
MCP_HOST=https://your-tunnel.example.com

# Shopify Partner app credentials. The merchant must have installed THIS app.
SHOPIFY_API_KEY=
SHOPIFY_API_SECRET=
SHOPIFY_SCOPES=read_products

# HS256 signing key for the OAuth state JWT. At least 32 characters.
# Generate one: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
OAUTH_STATE_SECRET=

PORT=3000

# The development store you will pick in Shopify's shop picker. The seed script
# creates its offline session; without a match the callback returns shop_not_installed.
DEMO_SHOP_DOMAIN=demo.myshopify.com
```

- [ ] **Step 4: Write `src/config.ts`**

```ts
import { z } from "zod";

const environmentSchema = z.object({
  MCP_HOST: z.string().url(),
  SHOPIFY_API_KEY: z.string().min(1),
  SHOPIFY_API_SECRET: z.string().min(1),
  SHOPIFY_SCOPES: z.string().min(1),
  OAUTH_STATE_SECRET: z.string().min(32),
  PORT: z.coerce.number().int().positive().default(3000),
  DEMO_SHOP_DOMAIN: z.string().min(1).default("demo.myshopify.com"),
});

export interface ExampleConfig {
  host: string;
  port: number;
  demoShopDomain: string;
  shopify: { apiKey: string; apiSecret: string; scopes: string };
  stateSecret: string;
}

export function loadConfig(
  environment: Record<string, string | undefined> = process.env
): ExampleConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))].join(", ");
    throw new Error(`Invalid environment — check these variables in .env: ${fields}`);
  }

  const values = parsed.data;
  return {
    host: values.MCP_HOST.replace(/\/+$/, ""),
    port: values.PORT,
    demoShopDomain: values.DEMO_SHOP_DOMAIN,
    shopify: {
      apiKey: values.SHOPIFY_API_KEY,
      apiSecret: values.SHOPIFY_API_SECRET,
      scopes: values.SHOPIFY_SCOPES,
    },
    stateSecret: values.OAUTH_STATE_SECRET,
  };
}
```

- [ ] **Step 5: Build the package, install, and run the test**

```bash
pnpm install
pnpm --filter shopify-mcp-oauth build
pnpm --filter basic-server test
```

Expected: PASS, 9 tests. The build step matters: pnpm links `shopify-mcp-oauth` through its `exports` map, which resolves to `dist/`. A stale or missing `dist/` surfaces later as "cannot find module 'shopify-mcp-oauth'".

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter basic-server typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add examples/basic-server
git commit -m "feat(example): scaffold the basic-server workspace with env config"
```

---

## Task 2: Prisma schema, Postgres, baseline migration, and seed

**Files:**
- Create: `examples/basic-server/prisma/schema.prisma`, `prisma/seed.ts`, `prisma/migrations/0_init/migration.sql`
- Create: `examples/basic-server/docker-compose.yml`
- Create: `examples/basic-server/src/demoSession.ts`
- Modify: `examples/basic-server/package.json` (Prisma dependencies and db scripts)
- Modify: `examples/basic-server/.env.example` (DATABASE_URL)
- Test: `examples/basic-server/src/demoSession.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `buildDemoOfflineSession(shopDomain, scope)` → `DemoOfflineSession`; the `Session`, `McpOAuthClient`, `McpOAuthToken`, and `McpAuditLog` models

The `Session` model is copied from what `shopify app init` generates, so anyone arriving from the
official Shopify template recognizes it and `PrismaSessionStorage` needs no mapping configuration.
`McpOAuthToken` deliberately carries no foreign key to `Session`: a shop has many sessions (one per
staff member, plus the offline one), and an adopter who moves sessions to Redis has no row to point at.

- [ ] **Step 1: Write the failing test**

`examples/basic-server/src/demoSession.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildDemoOfflineSession } from "./demoSession";

const DEMO_SHOP = "demo.myshopify.com";
const SCOPES = "read_products,write_products";

describe("buildDemoOfflineSession", () => {
  it("uses Shopify's offline session id convention so a real install overwrites it", () => {
    expect(buildDemoOfflineSession(DEMO_SHOP, SCOPES).id).toBe(`offline_${DEMO_SHOP}`);
  });

  it("records the shop and the scopes it was seeded with", () => {
    const session = buildDemoOfflineSession(DEMO_SHOP, SCOPES);
    expect(session.shop).toBe(DEMO_SHOP);
    expect(session.scope).toBe(SCOPES);
  });

  it("is offline and carries an access token, which is what the install gate checks", () => {
    const session = buildDemoOfflineSession(DEMO_SHOP, SCOPES);
    expect(session.isOnline).toBe(false);
    expect(session.accessToken.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter basic-server test src/demoSession.test.ts`
Expected: FAIL — cannot resolve `./demoSession`.

- [ ] **Step 3: Write `src/demoSession.ts`**

```ts
export interface DemoOfflineSession {
  id: string;
  shop: string;
  state: string;
  isOnline: false;
  scope: string;
  accessToken: string;
}

/**
 * The install gate only asks whether an offline session with an access token exists for the shop,
 * so a placeholder token is enough for local development. A real install replaces this row.
 */
export function buildDemoOfflineSession(shopDomain: string, scope: string): DemoOfflineSession {
  return {
    id: `offline_${shopDomain}`,
    shop: shopDomain,
    state: "seeded",
    isOnline: false,
    scope,
    accessToken: "seeded-placeholder-token",
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter basic-server test src/demoSession.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write `prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

/// Generated by `shopify app init`. @shopify/shopify-app-session-storage-prisma expects
/// this exact model and field naming.
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
  responseTypes           String[]
  logoUri                 String?
  clientUri               String?
  tokenEndpointAuthMethod String   @default("none")
  revokedAt               DateTime?
  createdAt               DateTime @default(now())
}

model McpOAuthToken {
  id                    String    @id @default(cuid())
  shopId                String
  shopDomain            String
  clientId              String
  accessTokenHash       String    @unique
  refreshTokenHash      String?   @unique
  accessTokenExpiresAt  DateTime
  refreshTokenExpiresAt DateTime?
  scope                 String?
  resource              String?
  revokedAt             DateTime?
  rotatedFromId         String?
  lastUsedAt            DateTime?
  createdAt             DateTime  @default(now())

  @@index([shopId])
  @@index([shopDomain])
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

- [ ] **Step 6: Write `docker-compose.yml` and extend `.env.example`**

`examples/basic-server/docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: mcp
      POSTGRES_PASSWORD: mcp
      POSTGRES_DB: mcp
    volumes:
      - mcp-postgres:/var/lib/postgresql/data

volumes:
  mcp-postgres:
```

Append to `examples/basic-server/.env.example`:

```
# Matches docker-compose.yml. Only used by the Prisma storage variant.
DATABASE_URL=postgresql://mcp:mcp@localhost:5432/mcp
```

- [ ] **Step 7: Add the Prisma dependencies and scripts**

Add to `examples/basic-server/package.json` `dependencies`:

```json
"@prisma/client": "^6.19.3",
"@shopify/shopify-app-session-storage-prisma": "^9.0.1"
```

Add to `devDependencies`:

```json
"prisma": "^6.19.3"
```

Add to `scripts`:

```json
"postinstall": "prisma generate",
"db:generate": "prisma generate",
"db:migrate": "prisma migrate deploy",
"db:migrate:dev": "prisma migrate dev",
"db:seed": "tsx prisma/seed.ts"
```

Then run: `pnpm install`
Expected: installs, and `postinstall` runs `prisma generate` successfully — it needs no database.

- [ ] **Step 8: Validate the schema**

Run: `pnpm --filter basic-server exec prisma validate`
Expected: "The schema at prisma/schema.prisma is valid 🚀". Fix any reported error before continuing.

- [ ] **Step 9: Generate the baseline migration without a database**

```bash
mkdir -p examples/basic-server/prisma/migrations/0_init
pnpm --filter basic-server exec prisma migrate diff \
  --from-empty \
  --to-schema-datamodel prisma/schema.prisma \
  --script > examples/basic-server/prisma/migrations/0_init/migration.sql
```

Verify the output:

```bash
grep -c 'CREATE TABLE' examples/basic-server/prisma/migrations/0_init/migration.sql
grep -o 'CREATE TABLE "[A-Za-z]*"' examples/basic-server/prisma/migrations/0_init/migration.sql
```

Expected: 4 tables — `Session`, `McpOAuthClient`, `McpOAuthToken`, `McpAuditLog`. `prisma migrate deploy`
applies this file to a fresh database; `migrate diff` is used here so the repository never needs a
running Postgres to produce it.

- [ ] **Step 10: Write `prisma/seed.ts`**

```ts
import { PrismaClient } from "@prisma/client";
import { buildDemoOfflineSession } from "../src/demoSession";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const shopDomain = process.env.DEMO_SHOP_DOMAIN ?? "demo.myshopify.com";
  const scope = process.env.SHOPIFY_SCOPES ?? "read_products";
  const session = buildDemoOfflineSession(shopDomain, scope);

  await prisma.session.upsert({ where: { id: session.id }, update: {}, create: session });

  console.log(`Seeded an offline session for ${shopDomain}.`);
  console.log("Pick this exact store in Shopify's shop picker, or the callback returns shop_not_installed.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 11: Typecheck**

Run: `pnpm --filter basic-server typecheck`
Expected: no errors. If `@prisma/client` has no `PrismaClient` export, `prisma generate` has not run —
run `pnpm --filter basic-server db:generate`.

- [ ] **Step 12: Commit**

```bash
git add examples/basic-server
git commit -m "feat(example): add prisma schema, baseline migration, and demo seed"
```

---

## Task 3: Audit sinks and client classification

**Files:**
- Create: `examples/basic-server/src/audit.ts`, `examples/basic-server/src/mcp/clientName.ts`
- Test: `examples/basic-server/src/audit.test.ts`, `examples/basic-server/src/mcp/clientName.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `AuditEntry`, `AuditSink`, `AuditPrismaClient`, `createPrismaAuditSink`, `createConsoleAuditSink`, `classifyClient`

- [ ] **Step 1: Write the failing tests**

`examples/basic-server/src/audit.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createConsoleAuditSink, createPrismaAuditSink, type AuditEntry } from "./audit";

const DEMO_SHOP = "demo.myshopify.com";
const TOKEN_ID = "token_1";

function buildEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    shopId: DEMO_SHOP,
    shopDomain: DEMO_SHOP,
    mcpTokenId: TOKEN_ID,
    toolName: "whoami",
    inputParams: {},
    output: { content: [] },
    mcpClient: "claude-code",
    status: "success",
    errorMessage: null,
    durationMs: 12,
    ...overrides,
  };
}

function buildAuditPrisma() {
  return { mcpAuditLog: { create: vi.fn().mockResolvedValue({}) } };
}

describe("createPrismaAuditSink", () => {
  it("writes one row carrying the tool, shop, and duration", async () => {
    const prisma = buildAuditPrisma();
    await createPrismaAuditSink(prisma)(buildEntry({ toolName: "echo", durationMs: 42 }));

    expect(prisma.mcpAuditLog.create).toHaveBeenCalledTimes(1);
    const { data } = prisma.mcpAuditLog.create.mock.calls[0]![0];
    expect(data).toMatchObject({
      shopId: DEMO_SHOP,
      mcpTokenId: TOKEN_ID,
      toolName: "echo",
      durationMs: 42,
    });
  });

  it("stringifies a numeric shop id, because the column is a string", async () => {
    const prisma = buildAuditPrisma();
    await createPrismaAuditSink(prisma)(buildEntry({ shopId: 77 }));

    expect(prisma.mcpAuditLog.create.mock.calls[0]![0].data.shopId).toBe("77");
  });

  it("records the failure message on an error entry", async () => {
    const prisma = buildAuditPrisma();
    await createPrismaAuditSink(prisma)(buildEntry({ status: "error", errorMessage: "handler exploded" }));

    expect(prisma.mcpAuditLog.create.mock.calls[0]![0].data).toMatchObject({
      status: "error",
      errorMessage: "handler exploded",
    });
  });

  it("never writes null into the non-nullable inputParams column", async () => {
    const prisma = buildAuditPrisma();
    await createPrismaAuditSink(prisma)(buildEntry({ inputParams: undefined }));

    expect(prisma.mcpAuditLog.create.mock.calls[0]![0].data.inputParams).toEqual({});
  });
});

describe("createConsoleAuditSink", () => {
  it("logs one line naming the tool, the shop, and the outcome", async () => {
    const logger = { info: vi.fn() };
    await createConsoleAuditSink(logger)(buildEntry({ toolName: "echo", status: "error" }));

    expect(logger.info).toHaveBeenCalledTimes(1);
    const line = logger.info.mock.calls[0]![0] as string;
    expect(line).toContain("echo");
    expect(line).toContain(DEMO_SHOP);
    expect(line).toContain("error");
  });
});
```

`examples/basic-server/src/mcp/clientName.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classifyClient, UNKNOWN_CLIENT_MAX_LENGTH } from "./clientName";

describe("classifyClient", () => {
  it("names a known client from its user-agent prefix", () => {
    expect(classifyClient("claude-code/2.1.0 (external, cli)")).toBe("claude-code");
  });

  it("reads the first value when the header arrives repeated", () => {
    expect(classifyClient(["cursor/1.4.2", "something-else"])).toBe("cursor");
  });

  it("falls back to unknown when no user-agent was sent", () => {
    expect(classifyClient(undefined)).toBe("unknown");
  });

  it("truncates an unrecognized user-agent so a hostile header cannot bloat the log", () => {
    const longAgent = "x".repeat(UNKNOWN_CLIENT_MAX_LENGTH + 50);
    expect(classifyClient(longAgent)).toHaveLength(UNKNOWN_CLIENT_MAX_LENGTH);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter basic-server test src/audit.test.ts src/mcp/clientName.test.ts`
Expected: FAIL — neither module resolves.

- [ ] **Step 3: Write `src/audit.ts`**

```ts
export interface AuditEntry {
  shopId: string | number;
  shopDomain: string;
  mcpTokenId: string | null;
  toolName: string;
  inputParams: unknown;
  output: unknown;
  mcpClient: string | null;
  status: "success" | "error";
  errorMessage: string | null;
  durationMs: number;
}

export type AuditSink = (entry: AuditEntry) => Promise<void>;

/** Structural, so this file never imports `@prisma/client` and the memory variant can drop it. */
export interface AuditPrismaClient {
  mcpAuditLog: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
}

export function createPrismaAuditSink(prisma: AuditPrismaClient): AuditSink {
  return async (entry) => {
    await prisma.mcpAuditLog.create({
      data: {
        shopId: String(entry.shopId),
        mcpTokenId: entry.mcpTokenId,
        toolName: entry.toolName,
        inputParams: entry.inputParams ?? {},
        output: entry.output ?? null,
        mcpClient: entry.mcpClient,
        status: entry.status,
        errorMessage: entry.errorMessage,
        durationMs: entry.durationMs,
      },
    });
  };
}

export function createConsoleAuditSink(logger: Pick<Console, "info"> = console): AuditSink {
  return async (entry) => {
    const suffix = entry.errorMessage ? ` — ${entry.errorMessage}` : "";
    logger.info(
      `[mcp] ${entry.toolName} ${entry.status} ${entry.durationMs}ms shop=${entry.shopDomain} client=${
        entry.mcpClient ?? "unknown"
      }${suffix}`
    );
  };
}
```

- [ ] **Step 4: Write `src/mcp/clientName.ts`**

```ts
export const UNKNOWN_CLIENT_MAX_LENGTH = 64;

const CLIENT_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["claude-code/", "claude-code"],
  ["Visual Studio Code/", "vscode"],
  ["VSCode/", "vscode"],
  ["cursor/", "cursor"],
  ["chatgpt/", "chatgpt"],
];

export function classifyClient(userAgent: string | string[] | undefined): string {
  const agent = Array.isArray(userAgent) ? userAgent[0] : userAgent;
  if (!agent) return "unknown";

  for (const [prefix, name] of CLIENT_PREFIXES) {
    if (agent.startsWith(prefix)) return name;
  }
  return agent.slice(0, UNKNOWN_CLIENT_MAX_LENGTH);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter basic-server test src/audit.test.ts src/mcp/clientName.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add examples/basic-server/src/audit.ts examples/basic-server/src/audit.test.ts examples/basic-server/src/mcp/clientName.ts examples/basic-server/src/mcp/clientName.test.ts
git commit -m "feat(example): add audit sinks and MCP client classification"
```

---

## Task 4: Storage wiring, Prisma and in-memory

**Files:**
- Create: `examples/basic-server/src/storage.ts`, `examples/basic-server/src/storage.memory.ts`
- Test: `examples/basic-server/src/storage.memory.test.ts`, `examples/basic-server/src/storage.contract.test.ts`

**Interfaces:**
- Consumes: `prismaStorage`, `shopifySessionStorage`, `memoryStorage`, `type OAuthStorage`,
  `type ShopifySessionStorageLike` from `shopify-mcp-oauth`; `createPrismaAuditSink`,
  `createConsoleAuditSink` from `./audit`; `buildDemoOfflineSession` from `./demoSession`
- Produces: both variants exporting `storage`, `sessionStorage`, `auditSink`; plus
  `createMemoryStorage(demoShopDomain)` for tests

Both files export the same three names so `index.ts` reads identically either way — that is what lets
the CLI swap one for the other with a rename. `storage.ts` constructs a `PrismaClient` at import, so
**tests never import it**; they import `storage.memory.ts`.

- [ ] **Step 1: Write the failing test**

`examples/basic-server/src/storage.memory.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "./storage.memory";

const DEMO_SHOP = "demo.myshopify.com";
const UNINSTALLED_SHOP = "never-installed.myshopify.com";

describe("createMemoryStorage", () => {
  it("resolves the seeded demo shop, keyed by its domain", async () => {
    const { storage } = createMemoryStorage(DEMO_SHOP);
    expect(await storage.findShopByDomain(DEMO_SHOP)).toEqual({ id: DEMO_SHOP, domain: DEMO_SHOP });
  });

  it("rejects a shop that was never seeded, which is the install gate", async () => {
    const { storage } = createMemoryStorage(DEMO_SHOP);
    expect(await storage.findShopByDomain(UNINSTALLED_SHOP)).toBeNull();
  });

  it("seeds the session through the real Shopify session storage interface", async () => {
    const { sessionStorage } = createMemoryStorage(DEMO_SHOP);
    const sessions = await sessionStorage.findSessionsByShop(DEMO_SHOP);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.isOnline).toBe(false);
  });

  it("stores and reads back a client, so the OAuth routes have somewhere to write", async () => {
    const { storage } = createMemoryStorage(DEMO_SHOP);
    await storage.createClient({
      clientId: "memory-client",
      clientName: "Memory Client",
      redirectUris: ["https://client.example/callback"],
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      logoUri: null,
      clientUri: null,
      tokenEndpointAuthMethod: "none",
    });
    expect((await storage.findClient("memory-client"))?.clientName).toBe("Memory Client");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter basic-server test src/storage.memory.test.ts`
Expected: FAIL — cannot resolve `./storage.memory`.

- [ ] **Step 3: Write `src/storage.memory.ts`**

```ts
import { Session } from "@shopify/shopify-api";
import { MemorySessionStorage } from "@shopify/shopify-app-session-storage-memory";
import {
  memoryStorage,
  shopifySessionStorage,
  type OAuthStorage,
  type ShopifySessionStorageLike,
} from "shopify-mcp-oauth";
import { createConsoleAuditSink, type AuditSink } from "./audit";
import { buildDemoOfflineSession } from "./demoSession";

export function createMemoryStorage(demoShopDomain: string): {
  storage: OAuthStorage;
  sessionStorage: ShopifySessionStorageLike;
  auditSink: AuditSink;
} {
  const sessions = new MemorySessionStorage();
  void sessions.storeSession(new Session(buildDemoOfflineSession(demoShopDomain, "read_products")));

  return {
    storage: {
      ...memoryStorage(),
      findShopByDomain: shopifySessionStorage(sessions),
    },
    sessionStorage: sessions,
    auditSink: createConsoleAuditSink(),
  };
}

const demo = createMemoryStorage(process.env.DEMO_SHOP_DOMAIN ?? "demo.myshopify.com");

export const storage = demo.storage;
export const sessionStorage = demo.sessionStorage;
export const auditSink = demo.auditSink;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter basic-server test src/storage.memory.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write `src/storage.ts`**

```ts
import { PrismaClient } from "@prisma/client";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import {
  prismaStorage,
  shopifySessionStorage,
  type OAuthStorage,
  type ShopifySessionStorageLike,
} from "shopify-mcp-oauth";
import { createPrismaAuditSink, type AuditSink } from "./audit";

export const prisma = new PrismaClient();

// Swap this one line for `new RedisSessionStorage(redis)` — or the Mongo, DynamoDB, or KV adapter —
// and nothing below changes. The shop lookup binds to Shopify's SessionStorage interface, not a table.
export const sessionStorage: ShopifySessionStorageLike = new PrismaSessionStorage(prisma);

export const storage: OAuthStorage = {
  ...prismaStorage(prisma),
  findShopByDomain: shopifySessionStorage(sessionStorage),
};

export const auditSink: AuditSink = createPrismaAuditSink(prisma);
```

- [ ] **Step 6: Add the opt-in Prisma contract test**

The package ships `runStorageContractTests`, but only the example has a Prisma schema to run it
against. This file is the one place `prismaStorage` meets a real database. It is **skipped unless
`DATABASE_URL` is set**, so the default suite still needs no Docker — and it announces the skip rather
than passing silently.

`examples/basic-server/src/storage.contract.test.ts`:

```ts
import { PrismaClient } from "@prisma/client";
import { prismaStorage } from "shopify-mcp-oauth";
import { runStorageContractTests } from "shopify-mcp-oauth/testing";
import { afterAll, describe, it } from "vitest";
import { buildDemoOfflineSession } from "./demoSession";

const DEMO_SHOP = "demo.myshopify.com";

if (!process.env.DATABASE_URL) {
  describe.skip("prismaStorage contract — set DATABASE_URL and run pnpm db:migrate to include it", () => {
    it("needs a database", () => undefined);
  });
} else {
  const prisma = new PrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  runStorageContractTests(
    async () => {
      await prisma.mcpOAuthToken.deleteMany();
      await prisma.mcpOAuthClient.deleteMany();

      const session = buildDemoOfflineSession(DEMO_SHOP, "read_products");
      await prisma.session.upsert({ where: { id: session.id }, update: {}, create: session });

      // Session rows key on the domain, so the shop's id is the domain itself — the same
      // ShopRef that shopifySessionStorage produces at runtime.
      return prismaStorage(prisma, { shop: { model: "session", domainField: "shop", idField: "shop" } });
    },
    { seedShop: { id: DEMO_SHOP, domain: DEMO_SHOP } }
  );
}
```

Run it both ways:

```bash
pnpm --filter basic-server test src/storage.contract.test.ts
docker compose -f examples/basic-server/docker-compose.yml up -d
DATABASE_URL=postgresql://mcp:mcp@localhost:5432/mcp pnpm --filter basic-server db:migrate
DATABASE_URL=postgresql://mcp:mcp@localhost:5432/mcp pnpm --filter basic-server test src/storage.contract.test.ts
```

Expected: skipped in the first run, and the full contract suite green in the second. A failure here is
a real defect in `prismaStorage` that the fake-client tests could not see.

- [ ] **Step 7: Typecheck both variants**

Run: `pnpm --filter basic-server typecheck`
Expected: no errors.

If TypeScript rejects `prismaStorage(prisma)` because the generated delegates do not match
`PrismaLikeClient`, do **not** loosen the package type. Use the documented escape hatch and record it
in the README's storage section:

```ts
import { prismaStorage, type PrismaLikeClient } from "shopify-mcp-oauth";
...(prismaStorage(prisma as unknown as PrismaLikeClient)),
```

- [ ] **Step 8: Commit**

```bash
git add examples/basic-server/src/storage.ts examples/basic-server/src/storage.memory.ts examples/basic-server/src/storage.memory.test.ts examples/basic-server/src/storage.contract.test.ts
git commit -m "feat(example): wire prisma and in-memory storage variants"
```

---

## Task 5: MCP request context and tool errors

**Files:**
- Create: `examples/basic-server/src/mcp/context.ts`, `examples/basic-server/src/mcp/errors.ts`
- Test: `examples/basic-server/src/mcp/context.test.ts`, `examples/basic-server/src/mcp/errors.test.ts`

**Interfaces:**
- Consumes: `type McpAuthContext` from `shopify-mcp-oauth`; `type AuditSink` from `../audit`
- Produces: `McpRequestContext`, `runWithMcpContext`, `getMcpContext`, `ERROR_CODES`, `McpToolError`

The MCP SDK gives a tool callback `extra.requestInfo`, which carries **headers only** — never the
Express request. `AsyncLocalStorage` is how the authenticated shop reaches a tool. The concurrency
test below is the one that matters: two overlapping requests must not see each other's shop.

- [ ] **Step 1: Write the failing tests**

`examples/basic-server/src/mcp/context.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { getMcpContext, runWithMcpContext, type McpRequestContext } from "./context";

const FIRST_SHOP = "first-store.myshopify.com";
const SECOND_SHOP = "second-store.myshopify.com";

function buildContext(shopDomain: string): McpRequestContext {
  return {
    auth: { shopId: shopDomain, shopDomain, tokenId: `token_${shopDomain}` },
    mcpClient: "claude-code",
    audit: vi.fn().mockResolvedValue(undefined),
  };
}

describe("mcp request context", () => {
  it("is null outside a request", () => {
    expect(getMcpContext()).toBeNull();
  });

  it("is visible to code running inside the request", async () => {
    await runWithMcpContext(buildContext(FIRST_SHOP), async () => {
      expect(getMcpContext()?.auth.shopDomain).toBe(FIRST_SHOP);
    });
  });

  it("survives an await boundary", async () => {
    await runWithMcpContext(buildContext(FIRST_SHOP), async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(getMcpContext()?.auth.shopDomain).toBe(FIRST_SHOP);
    });
  });

  it("keeps concurrent requests from seeing each other's shop", async () => {
    const observed: string[] = [];

    await Promise.all([
      runWithMcpContext(buildContext(FIRST_SHOP), async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        observed.push(getMcpContext()!.auth.shopDomain);
      }),
      runWithMcpContext(buildContext(SECOND_SHOP), async () => {
        observed.push(getMcpContext()!.auth.shopDomain);
      }),
    ]);

    expect(observed.sort()).toEqual([FIRST_SHOP, SECOND_SHOP].sort());
  });

  it("is null again after the request finishes", async () => {
    await runWithMcpContext(buildContext(FIRST_SHOP), async () => undefined);
    expect(getMcpContext()).toBeNull();
  });
});
```

`examples/basic-server/src/mcp/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ERROR_CODES, McpToolError } from "./errors";

describe("McpToolError", () => {
  it("renders MCP's error shape so the client sees a failure, not a crash", () => {
    const content = new McpToolError(ERROR_CODES.VALIDATION_FAILED, "Input failed schema validation").toContent();

    expect(content.isError).toBe(true);
    expect(content.content).toHaveLength(1);
    expect(content.content[0]!.type).toBe("text");
  });

  it("carries the code and message in the payload the model reads", () => {
    const content = new McpToolError(ERROR_CODES.DOWNSTREAM_ERROR, "upstream timed out").toContent();
    const payload = JSON.parse(content.content[0]!.text);

    expect(payload.code).toBe("DOWNSTREAM_ERROR");
    expect(payload.message).toBe("upstream timed out");
  });

  it("includes details when they are given", () => {
    const content = new McpToolError(ERROR_CODES.VALIDATION_FAILED, "bad input", { field: "message" }).toContent();
    expect(JSON.parse(content.content[0]!.text).details).toEqual({ field: "message" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter basic-server test src/mcp/context.test.ts src/mcp/errors.test.ts`
Expected: FAIL — neither module resolves.

- [ ] **Step 3: Write `src/mcp/context.ts`**

```ts
import { AsyncLocalStorage } from "node:async_hooks";
import type { McpAuthContext } from "shopify-mcp-oauth";
import type { AuditSink } from "../audit";

export interface McpRequestContext {
  auth: McpAuthContext;
  mcpClient: string;
  audit: AuditSink;
}

const contextStorage = new AsyncLocalStorage<McpRequestContext>();

export function runWithMcpContext<T>(context: McpRequestContext, fn: () => Promise<T>): Promise<T> {
  return contextStorage.run(context, fn);
}

export function getMcpContext(): McpRequestContext | null {
  return contextStorage.getStore() ?? null;
}
```

- [ ] **Step 4: Write `src/mcp/errors.ts`**

```ts
export const ERROR_CODES = {
  NOT_AUTHENTICATED: "NOT_AUTHENTICATED",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  DOWNSTREAM_ERROR: "DOWNSTREAM_ERROR",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ToolErrorContent {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
}

export class McpToolError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "McpToolError";
    this.code = code;
    this.details = details;
  }

  toContent(): ToolErrorContent {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ code: this.code, message: this.message, details: this.details }, null, 2),
        },
      ],
      isError: true,
    };
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter basic-server test src/mcp/context.test.ts src/mcp/errors.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add examples/basic-server/src/mcp/context.ts examples/basic-server/src/mcp/context.test.ts examples/basic-server/src/mcp/errors.ts examples/basic-server/src/mcp/errors.test.ts
git commit -m "feat(example): add the MCP request context and tool error type"
```

---

## Task 6: withAuditLog

**Files:**
- Create: `examples/basic-server/src/mcp/withAuditLog.ts`
- Test: `examples/basic-server/src/mcp/withAuditLog.test.ts`

**Interfaces:**
- Consumes: `getMcpContext` from `./context`; `ERROR_CODES`, `McpToolError` from `./errors`;
  `type AuditEntry` from `../audit`
- Produces: `ToolContext`, `ToolResult`, `WithAuditLogOptions`, `withAuditLog`

- [ ] **Step 1: Write the failing test**

`examples/basic-server/src/mcp/withAuditLog.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AuditEntry, AuditSink } from "../audit";
import { runWithMcpContext } from "./context";
import { ERROR_CODES, McpToolError } from "./errors";
import { withAuditLog } from "./withAuditLog";

const DEMO_SHOP = "demo.myshopify.com";
const TOKEN_ID = "token_1";
const ECHO_SCHEMA = z.object({ message: z.string().min(1) });

function runTool(
  callback: (rawInput: unknown) => Promise<unknown>,
  rawInput: unknown,
  audit: AuditSink,
  mcpClient = "claude-code"
) {
  return runWithMcpContext(
    {
      auth: { shopId: DEMO_SHOP, shopDomain: DEMO_SHOP, tokenId: TOKEN_ID },
      mcpClient,
      audit,
    },
    () => callback(rawInput) as Promise<unknown>
  );
}

function buildAuditSpy(): { sink: AuditSink; entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    sink: async (entry) => {
      entries.push(entry);
    },
  };
}

describe("withAuditLog", () => {
  it("passes validated input and the shop to the handler", async () => {
    const audit = buildAuditSpy();
    const handler = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const callback = withAuditLog({ toolName: "echo", schema: ECHO_SCHEMA, handler });

    await runTool(callback, { message: "hello" }, audit.sink);

    expect(handler).toHaveBeenCalledWith(
      { message: "hello" },
      { auth: { shopId: DEMO_SHOP, shopDomain: DEMO_SHOP, tokenId: TOKEN_ID }, mcpClient: "claude-code" }
    );
  });

  it("writes one success audit entry naming the tool and the client", async () => {
    const audit = buildAuditSpy();
    const callback = withAuditLog({
      toolName: "echo",
      schema: ECHO_SCHEMA,
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });

    await runTool(callback, { message: "hello" }, audit.sink, "cursor");

    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      toolName: "echo",
      shopDomain: DEMO_SHOP,
      mcpTokenId: TOKEN_ID,
      mcpClient: "cursor",
      status: "success",
      errorMessage: null,
    });
    expect(typeof audit.entries[0]!.durationMs).toBe("number");
  });

  it("rejects input that fails the schema without calling the handler", async () => {
    const audit = buildAuditSpy();
    const handler = vi.fn();
    const callback = withAuditLog({ toolName: "echo", schema: ECHO_SCHEMA, handler });

    const result = (await runTool(callback, { message: "" }, audit.sink)) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };

    expect(handler).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).code).toBe(ERROR_CODES.VALIDATION_FAILED);
    expect(audit.entries[0]!.status).toBe("error");
  });

  it("surfaces a thrown McpToolError with its own code", async () => {
    const audit = buildAuditSpy();
    const callback = withAuditLog({
      toolName: "echo",
      schema: ECHO_SCHEMA,
      handler: async () => {
        throw new McpToolError(ERROR_CODES.DOWNSTREAM_ERROR, "upstream timed out");
      },
    });

    const result = (await runTool(callback, { message: "hello" }, audit.sink)) as {
      content: Array<{ text: string }>;
    };

    expect(JSON.parse(result.content[0]!.text).code).toBe(ERROR_CODES.DOWNSTREAM_ERROR);
    expect(audit.entries[0]!.errorMessage).toBe("upstream timed out");
  });

  it("wraps an unexpected throw rather than crashing the request", async () => {
    const audit = buildAuditSpy();
    const callback = withAuditLog({
      toolName: "echo",
      schema: ECHO_SCHEMA,
      handler: async () => {
        throw new Error("null is not an object");
      },
    });

    const result = (await runTool(callback, { message: "hello" }, audit.sink)) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).code).toBe(ERROR_CODES.DOWNSTREAM_ERROR);
    expect(audit.entries[0]!.errorMessage).toBe("null is not an object");
  });

  it("still returns the result when the audit write fails", async () => {
    const failingSink: AuditSink = async () => {
      throw new Error("database unreachable");
    };
    const callback = withAuditLog({
      toolName: "echo",
      schema: ECHO_SCHEMA,
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });

    const result = (await runTool(callback, { message: "hello" }, failingSink)) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe("ok");
  });

  it("appends the narration line to a successful result, after the audit write", async () => {
    const audit = buildAuditSpy();
    const callback = withAuditLog({
      toolName: "echo",
      schema: ECHO_SCHEMA,
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
      narrate: (toolName) => `Say that this came from the ${toolName} tool.`,
    });

    const result = (await runTool(callback, { message: "hello" }, audit.sink)) as {
      content: Array<{ text: string }>;
    };

    expect(result.content).toHaveLength(2);
    expect(result.content[1]!.text).toBe("Say that this came from the echo tool.");
    expect((audit.entries[0]!.output as { content: unknown[] }).content).toHaveLength(1);
  });

  it("does not narrate a failure", async () => {
    const audit = buildAuditSpy();
    const callback = withAuditLog({
      toolName: "echo",
      schema: ECHO_SCHEMA,
      handler: async () => {
        throw new McpToolError(ERROR_CODES.DOWNSTREAM_ERROR, "upstream timed out");
      },
      narrate: (toolName) => `Say that this came from the ${toolName} tool.`,
    });

    const result = (await runTool(callback, { message: "hello" }, audit.sink)) as {
      content: Array<{ text: string }>;
    };

    expect(result.content).toHaveLength(1);
  });

  it("refuses to run outside an authenticated request and logs nothing", async () => {
    const audit = buildAuditSpy();
    const callback = withAuditLog({
      toolName: "echo",
      schema: ECHO_SCHEMA,
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });

    const result = (await callback({ message: "hello" })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).code).toBe(ERROR_CODES.NOT_AUTHENTICATED);
    expect(audit.entries).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter basic-server test src/mcp/withAuditLog.test.ts`
Expected: FAIL — cannot resolve `./withAuditLog`.

- [ ] **Step 3: Write `src/mcp/withAuditLog.ts`**

```ts
import { performance } from "node:perf_hooks";
import type { McpAuthContext } from "shopify-mcp-oauth";
import type { z } from "zod";
import type { AuditEntry } from "../audit";
import { getMcpContext } from "./context";
import { ERROR_CODES, McpToolError } from "./errors";

export interface ToolContext {
  auth: McpAuthContext;
  mcpClient: string;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface WithAuditLogOptions<TSchema extends z.ZodTypeAny> {
  toolName: string;
  schema: TSchema;
  handler: (input: z.infer<TSchema>, ctx: ToolContext) => Promise<ToolResult>;
  /** Appended to a successful result. Use it to make the calling agent credit your app by name. */
  narrate?: (toolName: string) => string;
}

export function withAuditLog<TSchema extends z.ZodTypeAny>(
  options: WithAuditLogOptions<TSchema>
): (rawInput: unknown) => Promise<ToolResult> {
  const { toolName, schema, handler, narrate } = options;

  return async (rawInput: unknown): Promise<ToolResult> => {
    // The SDK hands tool callbacks `extra.requestInfo` — headers only, never the Express request.
    // The authenticated shop therefore arrives through AsyncLocalStorage, set in transport.ts.
    const context = getMcpContext();
    if (!context) {
      return new McpToolError(
        ERROR_CODES.NOT_AUTHENTICATED,
        "Tool called outside an authenticated MCP request"
      ).toContent();
    }

    const startedAt = performance.now();
    let parsedInput = rawInput as z.infer<TSchema>;
    let status: AuditEntry["status"] = "success";
    let errorMessage: string | null = null;
    let result: ToolResult;

    try {
      const parsed = schema.safeParse(rawInput);
      if (!parsed.success) {
        throw new McpToolError(ERROR_CODES.VALIDATION_FAILED, "Input failed schema validation", {
          issues: parsed.error.issues,
        });
      }
      parsedInput = parsed.data;
      result = await handler(parsedInput, { auth: context.auth, mcpClient: context.mcpClient });
    } catch (thrown) {
      status = "error";
      const error = thrown as Error;
      errorMessage = error.message;
      result =
        thrown instanceof McpToolError
          ? thrown.toContent()
          : new McpToolError(ERROR_CODES.DOWNSTREAM_ERROR, error.message).toContent();
    }

    // Best effort: an audit-log outage must not turn a successful tool call into a failure.
    try {
      await context.audit({
        shopId: context.auth.shopId,
        shopDomain: context.auth.shopDomain,
        mcpTokenId: context.auth.tokenId,
        toolName,
        inputParams: parsedInput,
        output: result,
        mcpClient: context.mcpClient,
        status,
        errorMessage,
        durationMs: Math.round(performance.now() - startedAt),
      });
    } catch {
      // Deliberately swallowed.
    }

    // After the audit write, so the logged payload stays free of presentation text.
    if (status === "success" && narrate) {
      result.content.push({ type: "text", text: narrate(toolName) });
    }

    return result;
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter basic-server test src/mcp/withAuditLog.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add examples/basic-server/src/mcp/withAuditLog.ts examples/basic-server/src/mcp/withAuditLog.test.ts
git commit -m "feat(example): add the withAuditLog tool wrapper"
```

---

## Task 7: The whoami and echo tools

**Files:**
- Create: `examples/basic-server/src/tools/whoami.ts`, `src/tools/echo.ts`, `src/tools/index.ts`
- Test: `examples/basic-server/src/tools/whoami.test.ts`, `src/tools/echo.test.ts`

**Interfaces:**
- Consumes: `withAuditLog`, `type ToolResult` from `../mcp/withAuditLog`; `runWithMcpContext` from
  `../mcp/context` (tests only)
- Produces:
  - `whoamiTool` / `echoTool`, each `{ name, config, callback }` shaped for `server.registerTool`
  - `registerTools(server: McpServer): void`

Both tools deliberately do nothing but prove the plumbing: `whoami` shows that an authenticated tool
knows which shop is calling, `echo` shows input validation. Neither calls Shopify's Admin API — this
example is about auth, and an Admin API call would need scopes, a live token, and error handling that
distract from it.

- [ ] **Step 1: Write the failing tests**

`examples/basic-server/src/tools/whoami.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { runWithMcpContext } from "../mcp/context";
import { whoamiTool } from "./whoami";

const DEMO_SHOP = "demo.myshopify.com";
const TOKEN_ID = "token_1";

function callWhoami(shopDomain: string) {
  return runWithMcpContext(
    {
      auth: { shopId: shopDomain, shopDomain, tokenId: TOKEN_ID },
      mcpClient: "claude-code",
      audit: vi.fn().mockResolvedValue(undefined),
    },
    () => whoamiTool.callback({})
  );
}

describe("whoami tool", () => {
  it("is registered under a name a client can call", () => {
    expect(whoamiTool.name).toBe("whoami");
  });

  it("reports the shop the caller authenticated as", async () => {
    const result = await callWhoami(DEMO_SHOP);
    expect(JSON.parse(result.content[0]!.text).shop).toBe(DEMO_SHOP);
  });

  it("reports a different shop for a different caller", async () => {
    const result = await callWhoami("other-store.myshopify.com");
    expect(JSON.parse(result.content[0]!.text).shop).toBe("other-store.myshopify.com");
  });

  it("is annotated read-only so clients can call it without a confirmation prompt", () => {
    expect(whoamiTool.config.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });
});
```

`examples/basic-server/src/tools/echo.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { runWithMcpContext } from "../mcp/context";
import { ERROR_CODES } from "../mcp/errors";
import { echoTool } from "./echo";

const DEMO_SHOP = "demo.myshopify.com";

function callEcho(input: unknown) {
  return runWithMcpContext(
    {
      auth: { shopId: DEMO_SHOP, shopDomain: DEMO_SHOP, tokenId: "token_1" },
      mcpClient: "claude-code",
      audit: vi.fn().mockResolvedValue(undefined),
    },
    () => echoTool.callback(input)
  );
}

describe("echo tool", () => {
  it("returns the message it was given", async () => {
    const result = await callEcho({ message: "hello from the merchant" });
    expect(JSON.parse(result.content[0]!.text).message).toBe("hello from the merchant");
  });

  it("rejects an empty message through the shared validation path", async () => {
    const result = await callEcho({ message: "" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });

  it("rejects a missing message", async () => {
    const result = await callEcho({});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter basic-server test src/tools`
Expected: FAIL — neither tool module resolves.

- [ ] **Step 3: Write `src/tools/whoami.ts`**

```ts
import { z } from "zod";
import { withAuditLog } from "../mcp/withAuditLog";

const whoamiInputSchema = z.object({});

export const whoamiTool = {
  name: "whoami",
  config: {
    title: "Who am I",
    description:
      "Return the Shopify shop domain this MCP connection is authenticated for. Call it to confirm which store the tools will act on.",
    inputSchema: whoamiInputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  callback: withAuditLog({
    toolName: "whoami",
    schema: whoamiInputSchema,
    handler: async (_input, ctx) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ shop: ctx.auth.shopDomain, client: ctx.mcpClient }, null, 2),
        },
      ],
    }),
  }),
};
```

- [ ] **Step 4: Write `src/tools/echo.ts`**

```ts
import { z } from "zod";
import { withAuditLog } from "../mcp/withAuditLog";

const echoInputSchema = z.object({
  message: z.string().min(1).max(1000).describe("Text to send back unchanged"),
});

export const echoTool = {
  name: "echo",
  config: {
    title: "Echo",
    description: "Return the message you send, unchanged. Useful for checking that the connection works.",
    inputSchema: echoInputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  callback: withAuditLog({
    toolName: "echo",
    schema: echoInputSchema,
    handler: async (input) => ({
      content: [{ type: "text" as const, text: JSON.stringify({ message: input.message }, null, 2) }],
    }),
  }),
};
```

- [ ] **Step 5: Write `src/tools/index.ts`**

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { echoTool } from "./echo";
import { whoamiTool } from "./whoami";

export function registerTools(server: McpServer): void {
  server.registerTool(whoamiTool.name, whoamiTool.config, whoamiTool.callback);
  server.registerTool(echoTool.name, echoTool.config, echoTool.callback);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter basic-server test src/tools`
Expected: PASS, 7 tests.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter basic-server typecheck`
Expected: no errors. `registerTool` accepts a raw Zod shape as `inputSchema`; if TypeScript complains
about the callback's parameter type, the shape and the schema passed to `withAuditLog` have drifted
apart — they must come from the same `z.object`.

- [ ] **Step 8: Commit**

```bash
git add examples/basic-server/src/tools
git commit -m "feat(example): add the whoami and echo demo tools"
```

---

## Task 8: MCP server and stateless transport

**Files:**
- Create: `examples/basic-server/src/mcp/server.ts`, `examples/basic-server/src/mcp/transport.ts`
- Test: `examples/basic-server/src/mcp/transport.test.ts`

**Interfaces:**
- Consumes: `registerTools` from `../tools`; `runWithMcpContext` from `./context`; `classifyClient`
  from `./clientName`; `type AuditSink` from `../audit`
- Produces: `buildMcpServer(): McpServer`, `McpHandlerDeps`, `createMcpHandler(deps): RequestHandler`

Stateless is the right default for a tool server: a fresh `McpServer` and transport per POST, both
closed when the response closes. Session-ful mode would need a session store plus `GET` and `DELETE`
handlers to keep an SSE stream alive, and buys nothing when no tool holds state between calls.

The test drives the transport over real HTTP with a stub middleware standing in for `requireAuth`, so
it exercises the JSON-RPC path without the OAuth flow. Task 9 covers the two together.

- [ ] **Step 1: Write the failing test**

`examples/basic-server/src/mcp/transport.test.ts`:

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AuditEntry, AuditSink } from "../audit";
import { createMcpHandler } from "./transport";

const DEMO_SHOP = "demo.myshopify.com";
const TOKEN_ID = "token_1";
const MCP_ACCEPT = "application/json, text/event-stream";

function buildApp(audit: AuditSink, shopDomain = DEMO_SHOP) {
  const app = express();
  app.use(express.json());
  app.post(
    "/mcp",
    (req, _res, next) => {
      req.mcp = { shopId: shopDomain, shopDomain, tokenId: TOKEN_ID };
      next();
    },
    createMcpHandler({ audit })
  );
  return app;
}

/** The transport answers with SSE by default; a JSON body comes back when it chooses to. */
function readJsonRpc(response: request.Response): { result?: Record<string, unknown>; error?: unknown } {
  const contentType = String(response.headers["content-type"] ?? "");
  if (contentType.includes("application/json")) return response.body;

  const dataLine = response.text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error(`no JSON-RPC payload in response: ${response.text}`);
  return JSON.parse(dataLine.slice("data: ".length));
}

function post(app: express.Express, body: unknown, headers: Record<string, string> = {}) {
  return request(app).post("/mcp").set("Accept", MCP_ACCEPT).set(headers).send(body as object);
}

describe("createMcpHandler", () => {
  it("answers an initialize handshake", async () => {
    const response = await post(buildApp(vi.fn().mockResolvedValue(undefined)), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });

    expect(response.status).toBe(200);
    expect(readJsonRpc(response).result).toMatchObject({ serverInfo: { name: "basic-server" } });
  });

  it("lists both demo tools", async () => {
    const response = await post(buildApp(vi.fn().mockResolvedValue(undefined)), {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    const tools = (readJsonRpc(response).result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual(["echo", "whoami"]);
  });

  it("gives a tool the shop from req.mcp, which the SDK never passes through", async () => {
    const response = await post(buildApp(vi.fn().mockResolvedValue(undefined), "other-store.myshopify.com"), {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
    });

    const result = readJsonRpc(response).result as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]!.text).shop).toBe("other-store.myshopify.com");
  });

  it("records the calling client from the user-agent header", async () => {
    const entries: AuditEntry[] = [];
    const audit: AuditSink = async (entry) => {
      entries.push(entry);
    };

    await post(
      buildApp(audit),
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "echo", arguments: { message: "hi" } } },
      { "User-Agent": "claude-code/2.1.0 (external, cli)" }
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ toolName: "echo", mcpClient: "claude-code", status: "success" });
  });

  it("refuses a request that reached it without authentication", async () => {
    const app = express();
    app.use(express.json());
    app.post("/mcp", createMcpHandler({ audit: vi.fn().mockResolvedValue(undefined) }));

    const response = await request(app)
      .post("/mcp")
      .set("Accept", MCP_ACCEPT)
      .send({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} });

    expect(response.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter basic-server test src/mcp/transport.test.ts`
Expected: FAIL — cannot resolve `./transport`.

- [ ] **Step 3: Write `src/mcp/server.ts`**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const SERVER_NAME = "basic-server";
const SERVER_VERSION = "0.1.0";

export function buildMcpServer(): McpServer {
  return new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tools in this server act on one Shopify store — the one the merchant authenticated. " +
        "Call whoami first if you need to confirm which store that is.",
    }
  );
}
```

- [ ] **Step 4: Write `src/mcp/transport.ts`**

```ts
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { RequestHandler } from "express";
import type { AuditSink } from "../audit";
import { registerTools } from "../tools";
import { classifyClient } from "./clientName";
import { runWithMcpContext } from "./context";
import { buildMcpServer } from "./server";

export interface McpHandlerDeps {
  audit: AuditSink;
}

/**
 * Stateless: a fresh McpServer and transport per POST, both closed with the response. No tool here
 * holds state between calls, and statelessness means any instance can serve any request.
 *
 * The MCP SDK passes tool callbacks an `extra.requestInfo` carrying headers only — not the Express
 * request — so an authenticated tool cannot see which shop is calling. Wrapping both `server.connect`
 * and `transport.handleRequest` in `runWithMcpContext` is what makes `req.mcp` reachable from a tool.
 * Skip this and tools silently answer for the wrong store, or for none at all.
 */
export function createMcpHandler(deps: McpHandlerDeps): RequestHandler {
  return async (req, res) => {
    const auth = req.mcp;
    if (!auth) {
      res.status(401).json({ error: "invalid_token", error_description: "Authentication middleware did not run" });
      return;
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildMcpServer();
    registerTools(server);

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    await runWithMcpContext(
      { auth, mcpClient: classifyClient(req.headers["user-agent"]), audit: deps.audit },
      async () => {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      }
    );
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter basic-server test src/mcp/transport.test.ts`
Expected: PASS, 5 tests.

If a request comes back 406, the client did not send `Accept: application/json, text/event-stream` —
the transport requires both. If a `tools/call` returns "Server not initialized", the transport was
built with a `sessionIdGenerator`; stateless mode skips session validation and needs `undefined`.

- [ ] **Step 6: Commit**

```bash
git add examples/basic-server/src/mcp/server.ts examples/basic-server/src/mcp/transport.ts examples/basic-server/src/mcp/transport.test.ts
git commit -m "feat(example): add the stateless MCP server and transport"
```

---

## Task 9: App assembly and the end-to-end login test

**Files:**
- Create: `examples/basic-server/src/app.ts`, `examples/basic-server/src/index.ts`
- Test: `examples/basic-server/src/app.test.ts`

**Interfaces:**
- Consumes: `createShopifyMcpOAuth` from `shopify-mcp-oauth`; `createMcpHandler` from `./mcp/transport`;
  `loadConfig` from `./config`; `storage`, `auditSink` from `./storage`
- Produces: `AppDeps`, `createApp(deps): Express`, and a runnable `src/index.ts`

This is the task that proves the whole thing: a client registers, bounces through a stubbed Shopify,
redeems a code, and calls a tool that answers with the right shop domain. Everything before this
tested one unit against fakes.

- [ ] **Step 1: Write the failing test**

`examples/basic-server/src/app.test.ts`:

```ts
import crypto from "node:crypto";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { createMemoryStorage } from "./storage.memory";

const HOST = "https://mcp.example.com";
const API_SECRET = "test-api-secret";
const STATE_SECRET = "test-state-secret-at-least-32-bytes-long";
const DEMO_SHOP = "demo.myshopify.com";
const UNINSTALLED_SHOP = "never-installed.myshopify.com";
const REDIRECT_URI = "https://client.example/callback";
const CLIENT_STATE = "client-state-value";
const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const MCP_ACCEPT = "application/json, text/event-stream";

function buildApp(demoShopDomain = DEMO_SHOP) {
  const { storage, auditSink } = createMemoryStorage(demoShopDomain);
  return createApp({
    host: HOST,
    shopify: { apiKey: "test-api-key", apiSecret: API_SECRET, scopes: "read_products" },
    stateSecret: STATE_SECRET,
    storage,
    audit: auditSink,
    fetchImpl: vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "shpua_exchanged_token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ) as unknown as typeof fetch,
  });
}

function codeChallengeFor(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function signShopifyCallback(params: Record<string, string>): string {
  // Sorted by key, mirroring the algorithm shopify-mcp-oauth's own verifyShopifyHmac applies (see
  // that package's verifyShopifyHmac.test.ts) -- an insertion-order message produces a different
  // digest, and this fixture would 400 at the package's own HMAC gate before the rest of the
  // fixture (a real shop, a real code) ever mattered.
  const sortedEntries = Object.entries(params).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const message = new URLSearchParams(sortedEntries).toString();
  const hmac = crypto.createHmac("sha256", API_SECRET).update(message).digest("hex");
  return `${message}&hmac=${hmac}`;
}

function readJsonRpc(response: request.Response): { result?: Record<string, unknown> } {
  const contentType = String(response.headers["content-type"] ?? "");
  if (contentType.includes("application/json")) return response.body;

  const dataLine = response.text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error(`no JSON-RPC payload in response: ${response.text}`);
  return JSON.parse(dataLine.slice("data: ".length));
}

async function loginAndGetAccessToken(app: ReturnType<typeof buildApp>, shopDomain: string): Promise<string> {
  const registration = await request(app)
    .post("/register")
    .send({ client_name: "Example Test Client", redirect_uris: [REDIRECT_URI] });

  const authorize = await request(app).get("/authorize").query({
    response_type: "code",
    client_id: registration.body.client_id,
    redirect_uri: REDIRECT_URI,
    state: CLIENT_STATE,
    code_challenge: codeChallengeFor(CODE_VERIFIER),
    code_challenge_method: "S256",
  });

  const shopifyRedirect = new URL(authorize.headers.location).searchParams.get("redirect") ?? "";
  const stateJwt = new URLSearchParams(shopifyRedirect.split("?")[1]).get("state") ?? "";

  const callback = await request(app).get(
    `/oauth/shopify-callback?${signShopifyCallback({ shop: shopDomain, code: "shopify-code", state: stateJwt })}`
  );
  const authorizationCode = new URL(callback.headers.location).searchParams.get("code") ?? "";

  const token = await request(app).post("/token").type("form").send({
    grant_type: "authorization_code",
    code: authorizationCode,
    redirect_uri: REDIRECT_URI,
    client_id: registration.body.client_id,
    code_verifier: CODE_VERIFIER,
  });

  return token.body.access_token as string;
}

describe("basic-server app", () => {
  it("answers a health check", async () => {
    const response = await request(buildApp()).get("/health");
    expect(response.body).toEqual({ ok: true });
  });

  it("serves the protected-resource metadata clients start from", async () => {
    const response = await request(buildApp()).get("/.well-known/oauth-protected-resource");
    expect(response.status).toBe(200);
    expect(response.body.resource).toBe(`${HOST}/mcp`);
  });

  it("rejects an unauthenticated MCP call and says where to authenticate", async () => {
    const response = await request(buildApp())
      .post("/mcp")
      .set("Accept", MCP_ACCEPT)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("oauth-protected-resource");
  });

  it("carries a client from registration to a tool call that names the shop", async () => {
    const app = buildApp();
    const accessToken = await loginAndGetAccessToken(app, DEMO_SHOP);

    const call = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${accessToken}`)
      .set("Accept", MCP_ACCEPT)
      .send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoami", arguments: {} } });

    const result = readJsonRpc(call).result as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]!.text).shop).toBe(DEMO_SHOP);
  });

  it("echoes through the same authenticated path", async () => {
    const app = buildApp();
    const accessToken = await loginAndGetAccessToken(app, DEMO_SHOP);

    const call = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${accessToken}`)
      .set("Accept", MCP_ACCEPT)
      .send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "echo", arguments: { message: "hello from the merchant" } },
      });

    const result = readJsonRpc(call).result as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]!.text).message).toBe("hello from the merchant");
  });

  it("stops a shop that never installed the app, even though Shopify's bounce succeeded", async () => {
    const app = buildApp();
    const registration = await request(app).post("/register").send({ redirect_uris: [REDIRECT_URI] });
    const authorize = await request(app).get("/authorize").query({
      response_type: "code",
      client_id: registration.body.client_id,
      redirect_uri: REDIRECT_URI,
      state: CLIENT_STATE,
      code_challenge: codeChallengeFor(CODE_VERIFIER),
      code_challenge_method: "S256",
    });

    const shopifyRedirect = new URL(authorize.headers.location).searchParams.get("redirect") ?? "";
    const stateJwt = new URLSearchParams(shopifyRedirect.split("?")[1]).get("state") ?? "";
    const callback = await request(app).get(
      `/oauth/shopify-callback?${signShopifyCallback({
        shop: UNINSTALLED_SHOP,
        code: "shopify-code",
        state: stateJwt,
      })}`
    );

    expect(callback.status).toBe(403);
    expect(callback.text).toContain("shop_not_installed");
  });

  it("answers 405 on GET /mcp so a browser gets a clear error", async () => {
    const response = await request(buildApp()).get("/mcp");
    expect(response.status).toBe(405);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter basic-server test src/app.test.ts`
Expected: FAIL — cannot resolve `./app`.

- [ ] **Step 3: Write `src/app.ts`**

```ts
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
```

- [ ] **Step 4: Write `src/index.ts`**

```ts
import { createApp } from "./app";
import { loadConfig } from "./config";
import { auditSink, storage } from "./storage";

const config = loadConfig();

const app = createApp({
  host: config.host,
  shopify: config.shopify,
  stateSecret: config.stateSecret,
  storage,
  audit: auditSink,
});

app.listen(config.port, () => {
  console.log(`MCP server listening on port ${config.port}`);
  console.log(`Public host: ${config.host}`);
  console.log(`Connect with: claude mcp add --transport http my-mcp ${config.host}/mcp`);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter basic-server test src/app.test.ts`
Expected: PASS, 7 tests. A failure here is a mismatch between two units that each pass in isolation —
fix the unit, not this test.

- [ ] **Step 6: Run the whole example suite and typecheck**

Run: `pnpm --filter basic-server test && pnpm --filter basic-server typecheck`
Expected: all green — 61 passed, plus 1 skipped: the Prisma contract suite, which runs only with
`DATABASE_URL` set.

- [ ] **Step 7: Commit**

```bash
git add examples/basic-server/src/app.ts examples/basic-server/src/app.test.ts examples/basic-server/src/index.ts
git commit -m "feat(example): assemble the express app and cover the full login flow"
```

---

## Task 10: Example README

**Files:**
- Create: `examples/basic-server/README.md`

**Interfaces:**
- Consumes: everything built above
- Produces: the setup document; plan 3's CLI prints an abbreviated version of the same steps

The first-run failure mode is specific and worth leading with: the tester picks a store in Shopify's
picker that has no seeded session, gets `shop_not_installed`, and reads it as a bug.

- [ ] **Step 1: Write `examples/basic-server/README.md`**

````markdown
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
`DEMO_SHOP_DOMAIN` to your development store's `*.myshopify.com` domain.

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

`403 shop_not_installed` after picking a store means no offline session exists for that shop. The
install gate is deliberate: completing Shopify's flow does **not** prove the app was installed
beforehand — Shopify installs it on approval — so without this check any merchant on Shopify could
mint a token for your server.

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
  ...prismaStorage(prisma),                            // clients and tokens
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
````

- [ ] **Step 2: Verify every command in the README**

Run each block that does not need a Partner app:

```bash
cd examples/basic-server
cp .env.example .env.check && rm .env.check
docker compose config > /dev/null
pnpm db:generate
```

Expected: no errors. Fix the README where a command's name or path is wrong.

- [ ] **Step 3: Check the scrub list**

```bash
grep -rniE "storeseo|dataforseo|myshopify\.com" examples/basic-server --include="*.ts" --include="*.md" --include="*.json" --include="*.prisma" | grep -v "demo.myshopify.com" | grep -v "other-store.myshopify.com" | grep -v "never-installed.myshopify.com" | grep -v "your-store.myshopify.com" | grep -v "first-store.myshopify.com" | grep -v "second-store.myshopify.com"
```

Expected: no output. Any hit is a real store domain or an internal name that must not ship.

- [ ] **Step 4: Commit**

```bash
git add examples/basic-server/README.md
git commit -m "docs(example): add the partner app and tunnel setup guide"
```

---

## Done

`examples/basic-server` now runs, tests green with no Docker and no database, and demonstrates the one
thing the package cannot ship: the MCP runner that carries the authenticated shop into a tool.

Plan 3 turns this directory into the `create-shopify-mcp` template, adds the root README and
`docs/storage-adapters.md`, and sets up CI. Nothing in plan 3 changes the files built here — the CLI
copies them at pack time, which is what keeps the demo and the scaffold from drifting.
