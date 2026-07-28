# shopify-mcp-oauth Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the publishable `shopify-mcp-oauth` package — an OAuth 2.1 Authorization Server and Resource Server for a Shopify app's MCP endpoint, with storage behind an interface.

**Architecture:** An Express `Router` carrying discovery, `/authorize`, `/token`, `/register`, `/revoke`, and the Shopify callback, plus a `requireAuth` middleware for the protected `/mcp` route. Merchant identity comes from Shopify: `/authorize` bounces the browser through Shopify's shop picker, and the callback's server-to-server token exchange proves the merchant controls that shop. All persistence goes through an `OAuthStorage` interface; short-lived authorization codes and fetched CIMD documents go through a `CacheStore`.

**Tech Stack:** TypeScript (strict), Express 4/5 (peer), Zod (peer), `jsonwebtoken`, Node `node:crypto`, Vitest, tsup.

This is **plan 1 of 3**. Plan 2 builds `examples/basic-server`; plan 3 builds `create-shopify-mcp` plus the docs and CI polish. Nothing here depends on the later plans.

Spec: `docs/superpowers/specs/2026-07-27-shopify-mcp-oauth-boilerplate-design.md`

## Global Constraints

- Node ≥ 20. `package.json` sets `"engines": { "node": ">=20" }`.
- TypeScript `strict: true`. No `any` in exported signatures.
- Build with tsup to **ESM + CJS + .d.ts**. `express` and `zod` are **peer** dependencies so the adopter's versions win.
- Test runner is **Vitest**. Never invoke Jest.
- Formatting: double quotes, 120 print width, 2-space indent, trailing comma `es5`.
- Every secret-bearing value (tokens, codes) is stored **hashed with SHA-256**, never in plaintext.
- Comments are minimal: only where the *why* is non-obvious (a spec citation, a security invariant). Never narrate what the code does.
- Test data uses readable named constants (`const DEMO_SHOP = "demo.myshopify.com"`) referenced from both setup and assertion. Never assert on a factory default.
- No app-specific names, domains, vendor names, or real credentials anywhere in the tree.
- License: MIT.

---

## File Structure

```
packages/shopify-mcp-oauth/
  src/
    types.ts                        OAuthStorage, CacheStore, domain types
    config.ts                       config Zod schema + resolveConfig()
    crypto.ts                       randomBase64Url, sha256Hex, safeEqual
    errors.ts                       OAuthError + the RFC error codes
    services/
      pkce.ts                       verifyS256
      redirectUri.ts                validateRedirectUri, redirectUriMatches
      stateJwt.ts                   signOuterState, verifyOuterState
      clients.ts                    createDcrClient, findClientById, upsertCimdClient
      cimd.ts                       isCimdClientId, resolveCimdClient
      codes.ts                      issueCode, consumeCode
      tokens.ts                     issueTokens, rotateRefresh, revokeBy*, findActiveToken
    adapters/
      memoryStorage.ts              memoryStorage()
      memoryCache.ts                memoryCache()
      redisCache.ts                 redisCache(client)
      prismaStorage.ts              prismaStorage(prisma, opts?)
      shopifySessionStorage.ts      shopifySessionStorage(sessionStorage)
      allowAnyShop.ts               allowAnyShop()
    schemas/
      authorize.ts  token.ts  register.ts  revoke.ts  shopifyCallback.ts  cimd.ts
    serializers/
      metadata.ts  register.ts  token.ts
    controllers/
      metadata.ts  register.ts  authorize.ts  shopifyCallback.ts  token.ts  revoke.ts
      openaiAppsChallenge.ts
    middlewares/
      requireAuth.ts  verifyShopifyHmac.ts  rateLimit.ts
    router.ts                       buildRouter(resolved)
    index.ts                        createShopifyMcpOAuth + public exports
    testing/
      storageContract.ts            runStorageContractTests
  package.json  tsconfig.json  tsup.config.ts  vitest.config.ts
```

Tests are co-located: `src/services/pkce.test.ts` next to `src/services/pkce.ts`.

---

## Locked Interfaces

Every task below consumes or produces from this set. Names here are authoritative — a later task using a different spelling is a bug.

```ts
// types.ts
export interface ShopRef {
  id: string | number;
  domain: string;
}

export interface OAuthClient {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  grantTypes: string[] | null;
  responseTypes: string[] | null;
  logoUri: string | null;
  clientUri: string | null;
  tokenEndpointAuthMethod: string;
  revokedAt: Date | null;
}
export type NewOAuthClient = Omit<OAuthClient, "revokedAt">;

export interface StoredToken {
  id: string;
  shopId: string | number;
  /** Denormalized so the resource server can name the shop without a reverse lookup by id. */
  shopDomain: string;
  clientId: string;
  accessTokenHash: string;
  refreshTokenHash: string | null;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date | null;
  scope: string | null;
  resource: string | null;
  revokedAt: Date | null;
  rotatedFromId: string | null;
}
export type NewToken = Omit<StoredToken, "id" | "revokedAt">;

export interface OAuthStorage {
  findClient(clientId: string): Promise<OAuthClient | null>;
  createClient(client: NewOAuthClient): Promise<OAuthClient>;
  upsertClient(client: NewOAuthClient): Promise<OAuthClient>;
  createToken(token: NewToken): Promise<StoredToken>;
  findTokenByAccessHash(hash: string): Promise<StoredToken | null>;
  /**
   * Same match as findTokenByAccessHash, but ignores accessTokenExpiresAt — an expired access
   * token still names a real grant, and /revoke must be able to kill that grant (including its
   * still-live refresh token) after the access token has expired. Still excludes an already-
   * revoked row, so this can't resurrect a dead grant.
   */
  findTokenByAccessHashIgnoringExpiry(hash: string): Promise<StoredToken | null>;
  findTokenByRefreshHash(hash: string): Promise<StoredToken | null>;
  /** Returns false when the row was already revoked. Rotation relies on this for one-time use. */
  revokeToken(id: string): Promise<boolean>;
  touchToken(id: string, lastUsedAt: Date): Promise<void>;
  findShopByDomain(domain: string): Promise<ShopRef | null>;
}

export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /**
   * Read and delete in a single atomic step: of two concurrent callers on the same key, exactly
   * one may see the value. This is what makes an authorization code single-use, so a get-then-del
   * implementation is not a valid substitute — required, not optional, so a non-atomic cache is
   * rejected at the type level instead of silently allowing a code to be redeemed twice.
   */
  getdel(key: string): Promise<string | null>;
}

export interface Logger {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export interface McpAuthContext {
  shopId: string | number;
  shopDomain: string;
  tokenId: string;
}
```

```ts
// config.ts
export interface ShopifyMcpOAuthConfig {
  host: string;
  shopify: { apiKey: string; apiSecret: string; scopes: string };
  stateSecret: string;
  storage: OAuthStorage;
  cache?: CacheStore;
  tokenTtl?: { access?: number; refresh?: number };
  openaiAppsChallengeToken?: string | null;
  registerRateLimit?: { limit: number; windowMs: number };
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

export interface ResolvedConfig {
  host: string;
  resource: string; // `${host}/mcp`
  shopify: { apiKey: string; apiSecret: string; scopes: string };
  stateSecret: string;
  storage: OAuthStorage;
  cache: CacheStore;
  tokenTtl: { access: number; refresh: number };
  openaiAppsChallengeToken: string | null;
  registerRateLimit: { limit: number; windowMs: number };
  logger: Logger;
  fetchImpl: typeof fetch;
}

export function resolveConfig(input: ShopifyMcpOAuthConfig): ResolvedConfig;
```

```ts
// index.ts
export interface ShopifyMcpOAuth {
  router: Router;
  requireAuth: RequestHandler;
}
export interface BuildRouterOptions {
  /** Test-only escape hatch: skips the CIMD private-address guard. Never set this in production. */
  allowPrivateCimdHosts?: boolean;
}
export function createShopifyMcpOAuth(
  config: ShopifyMcpOAuthConfig,
  options?: BuildRouterOptions
): ShopifyMcpOAuth;
```

`requireAuth` sets `req.mcp: McpAuthContext` on success.

---

## Task 1: Workspace skeleton

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.prettierrc`, `LICENSE`
- Create: `packages/shopify-mcp-oauth/package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`
- Create: `packages/shopify-mcp-oauth/src/index.ts`, `src/index.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a buildable, testable workspace. Later tasks add files under `packages/shopify-mcp-oauth/src/`.

- [ ] **Step 1: Write the failing test**

`packages/shopify-mcp-oauth/src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index";

describe("package entry", () => {
  it("exposes its own name", () => {
    expect(PACKAGE_NAME).toBe("shopify-mcp-oauth");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter shopify-mcp-oauth test`
Expected: FAIL — the workspace does not exist yet, or `./index` has no `PACKAGE_NAME` export.

- [ ] **Step 3: Create the root workspace files**

`package.json`:

```json
{
  "name": "shopify-mcp",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck",
    "format": "prettier --write ."
  },
  "devDependencies": {
    "prettier": "^3.3.3",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "examples/*"
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "types": ["node"]
  }
}
```

`.prettierrc`:

```json
{
  "printWidth": 120,
  "tabWidth": 2,
  "semi": true,
  "singleQuote": false,
  "trailingComma": "es5"
}
```

`.gitignore`:

```
node_modules/
dist/
coverage/
*.tsbuildinfo
.env
.DS_Store
packages/create-shopify-mcp/templates/
```

`.prettierignore` — without this, the `prettier --check .` lint gate fails on the lockfile,
generated output, and every markdown file in the repo:

```
node_modules/
dist/
coverage/
pnpm-lock.yaml
docs/
.superpowers/
```

`LICENSE`: the standard MIT text, copyright the repository owner, year 2026.

- [ ] **Step 4: Create the package files**

`packages/shopify-mcp-oauth/package.json`:

```json
{
  "name": "shopify-mcp-oauth",
  "version": "0.1.0",
  "description": "OAuth 2.1 authorization + resource server for a Shopify app's MCP endpoint",
  "license": "MIT",
  "type": "module",
  "engines": { "node": ">=20" },
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    },
    "./testing": {
      "types": "./dist/testing.d.ts",
      "import": "./dist/testing.js",
      "require": "./dist/testing.cjs"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "jsonwebtoken": "^9.0.2"
  },
  "peerDependencies": {
    "express": ">=5",
    "zod": ">=3.23"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/jsonwebtoken": "^9.0.7",
    "@types/node": "^22.0.0",
    "express": "^5.0.0",
    "supertest": "^7.0.0",
    "@types/supertest": "^6.0.2",
    "tsup": "^8.3.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "zod": "^3.23.8"
  },
  "publishConfig": { "access": "public" }
}
```

`packages/shopify-mcp-oauth/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`packages/shopify-mcp-oauth/tsup.config.ts`:

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
});
```

`packages/shopify-mcp-oauth/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

`packages/shopify-mcp-oauth/src/index.ts`:

```ts
export const PACKAGE_NAME = "shopify-mcp-oauth";
```

- [ ] **Step 5: Install and run the test to verify it passes**

Run: `pnpm install && pnpm --filter shopify-mcp-oauth test`
Expected: PASS, 1 test.

- [ ] **Step 6: Verify typecheck and build both work**

Run: `pnpm --filter shopify-mcp-oauth typecheck && pnpm --filter shopify-mcp-oauth build`
Expected: no errors; `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts` exist.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm workspace and shopify-mcp-oauth package"
```

---

## Task 2: Core types and errors

**Files:**
- Create: `packages/shopify-mcp-oauth/src/types.ts`
- Create: `packages/shopify-mcp-oauth/src/errors.ts`
- Test: `packages/shopify-mcp-oauth/src/errors.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: every type in the **Locked Interfaces** section above, plus:
  - `class OAuthError extends Error` with `constructor(code: string, description: string, status?: number)`, fields `code`, `description`, `status`, and `toBody(): { error: string; error_description: string }`

- [ ] **Step 1: Write the failing test**

`src/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { OAuthError } from "./errors";

const INVALID_GRANT = "invalid_grant";

describe("OAuthError", () => {
  it("defaults to HTTP 400", () => {
    const error = new OAuthError(INVALID_GRANT, "code already used");
    expect(error.status).toBe(400);
  });

  it("serializes to the RFC 6749 error body", () => {
    const error = new OAuthError(INVALID_GRANT, "code already used");
    expect(error.toBody()).toEqual({ error: INVALID_GRANT, error_description: "code already used" });
  });

  it("carries an explicit status when given one", () => {
    const error = new OAuthError("shop_not_installed", "Install the app first.", 403);
    expect(error.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter shopify-mcp-oauth test src/errors.test.ts`
Expected: FAIL — cannot resolve `./errors`.

- [ ] **Step 3: Write `src/types.ts`**

Copy the full contents of the **Locked Interfaces** `types.ts` block above verbatim into this file.

- [ ] **Step 4: Write `src/errors.ts`**

```ts
export class OAuthError extends Error {
  readonly code: string;
  readonly description: string;
  readonly status: number;

  constructor(code: string, description: string, status = 400) {
    super(`${code}: ${description}`);
    this.name = "OAuthError";
    this.code = code;
    this.description = description;
    this.status = status;
  }

  toBody(): { error: string; error_description: string } {
    return { error: this.code, error_description: this.description };
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter shopify-mcp-oauth test src/errors.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/shopify-mcp-oauth/src/types.ts packages/shopify-mcp-oauth/src/errors.ts packages/shopify-mcp-oauth/src/errors.test.ts
git commit -m "feat: add core storage types and OAuthError"
```

---

## Task 3: Crypto helpers and PKCE

**Files:**
- Create: `packages/shopify-mcp-oauth/src/crypto.ts`
- Create: `packages/shopify-mcp-oauth/src/services/pkce.ts`
- Test: `packages/shopify-mcp-oauth/src/crypto.test.ts`, `packages/shopify-mcp-oauth/src/services/pkce.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `randomBase64Url(bytes: number): string`
  - `sha256Hex(input: string): string`
  - `sha256Base64Url(input: string): string`
  - `safeEqual(a: string, b: string): boolean`
  - `verifyS256(verifier: string, expectedChallenge: string): boolean`

- [ ] **Step 1: Write the failing tests**

`src/crypto.test.ts`:

```ts
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { randomBase64Url, safeEqual, sha256Base64Url, sha256Hex } from "./crypto";

// RFC 7636 Appendix B.1 test vector.
const RFC7636_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC7636_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("randomBase64Url", () => {
  it("emits URL-safe characters only", () => {
    expect(randomBase64Url(32)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("does not repeat across calls", () => {
    expect(randomBase64Url(32)).not.toBe(randomBase64Url(32));
  });
});

describe("sha256Hex", () => {
  it("matches node's own digest", () => {
    const input = "hello";
    expect(sha256Hex(input)).toBe(crypto.createHash("sha256").update(input).digest("hex"));
  });
});

describe("sha256Base64Url", () => {
  it("produces the known-good RFC 7636 challenge", () => {
    expect(sha256Base64Url(RFC7636_VERIFIER)).toBe(RFC7636_CHALLENGE);
  });
});

describe("safeEqual", () => {
  it("is true for identical strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
  });

  it("is false for different lengths", () => {
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  it("is false for same-length differing strings", () => {
    expect(safeEqual("abc", "abd")).toBe(false);
  });
});
```

`src/services/pkce.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { verifyS256 } from "./pkce";

// RFC 7636 Appendix B.1 test vector.
const RFC7636_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC7636_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("verifyS256", () => {
  it("accepts the verifier that produced the challenge", () => {
    expect(verifyS256(RFC7636_VERIFIER, RFC7636_CHALLENGE)).toBe(true);
  });

  it("rejects a different verifier", () => {
    expect(verifyS256("not-the-verifier", RFC7636_CHALLENGE)).toBe(false);
  });

  it("rejects an empty verifier", () => {
    expect(verifyS256("", RFC7636_CHALLENGE)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter shopify-mcp-oauth test src/crypto.test.ts src/services/pkce.test.ts`
Expected: FAIL — cannot resolve `./crypto` and `./pkce`.

- [ ] **Step 3: Write `src/crypto.ts`**

```ts
import crypto from "node:crypto";

function toBase64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function randomBase64Url(bytes: number): string {
  return toBase64Url(crypto.randomBytes(bytes));
}

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function sha256Base64Url(input: string): string {
  return toBase64Url(crypto.createHash("sha256").update(input).digest());
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
```

- [ ] **Step 4: Write `src/services/pkce.ts`**

```ts
import { safeEqual, sha256Base64Url } from "../crypto";

export function verifyS256(verifier: string, expectedChallenge: string): boolean {
  if (!verifier) return false;
  return safeEqual(sha256Base64Url(verifier), expectedChallenge);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter shopify-mcp-oauth test src/crypto.test.ts src/services/pkce.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/shopify-mcp-oauth/src/crypto.ts packages/shopify-mcp-oauth/src/crypto.test.ts packages/shopify-mcp-oauth/src/services/pkce.ts packages/shopify-mcp-oauth/src/services/pkce.test.ts
git commit -m "feat: add crypto helpers and S256 PKCE verification"
```

---

## Task 4: Redirect URI validation and matching

**Files:**
- Create: `packages/shopify-mcp-oauth/src/services/redirectUri.ts`
- Test: `packages/shopify-mcp-oauth/src/services/redirectUri.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `validateRedirectUri(uri: string): string | null` — returns an error message, or `null` when acceptable
  - `redirectUriMatches(registered: string, requested: string): boolean`

- [ ] **Step 1: Write the failing test**

`src/services/redirectUri.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { redirectUriMatches, validateRedirectUri } from "./redirectUri";

const HTTPS_CALLBACK = "https://client.example/callback";
const LOOPBACK_CALLBACK = "http://127.0.0.1:8976/callback";
const PRIVATE_SCHEME_CALLBACK = "com.example.app://oauth";
const REGISTERED_HTTPS = "https://good.example.com/cb";
const SUFFIX_ATTACK = "https://good.example.com.evil.test/cb";
const USERINFO_WITH_USER = "https://attacker@client.example/callback";
const USERINFO_WITH_PASS = "https://user:password@client.example/callback";
const LOOPBACK_VARIANT = "http://127.0.0.5:8976/callback";

describe("validateRedirectUri", () => {
  it("accepts https", () => {
    expect(validateRedirectUri(HTTPS_CALLBACK)).toBeNull();
  });

  it("accepts http on loopback", () => {
    expect(validateRedirectUri(LOOPBACK_CALLBACK)).toBeNull();
  });

  it("accepts a private-use scheme", () => {
    expect(validateRedirectUri(PRIVATE_SCHEME_CALLBACK)).toBeNull();
  });

  it("rejects http on a public host", () => {
    expect(validateRedirectUri("http://client.example/callback")).toMatch(/loopback/);
  });

  it("rejects javascript: URIs", () => {
    expect(validateRedirectUri("javascript:alert(1)")).toMatch(/not allowed/);
  });

  it("rejects unparseable input", () => {
    expect(validateRedirectUri("not a url")).toMatch(/valid URL/);
  });

  it("rejects userinfo (username)", () => {
    expect(validateRedirectUri(USERINFO_WITH_USER)).toMatch(/userinfo/);
  });

  it("rejects userinfo (username:password)", () => {
    expect(validateRedirectUri(USERINFO_WITH_PASS)).toMatch(/userinfo/);
  });

  it("accepts loopback address 127.0.0.5", () => {
    expect(validateRedirectUri(LOOPBACK_VARIANT)).toBeNull();
  });
});

describe("redirectUriMatches", () => {
  it("matches an identical URI", () => {
    expect(redirectUriMatches(HTTPS_CALLBACK, HTTPS_CALLBACK)).toBe(true);
  });

  it("ignores the port on loopback, per RFC 8252 section 7.3", () => {
    expect(redirectUriMatches("http://127.0.0.1:1234/callback", "http://127.0.0.1:55555/callback")).toBe(true);
  });

  it("does not ignore the port on a public host", () => {
    expect(redirectUriMatches("https://client.example:443/cb", "https://client.example:8443/cb")).toBe(false);
  });

  it("rejects a different path", () => {
    expect(redirectUriMatches(HTTPS_CALLBACK, "https://client.example/other")).toBe(false);
  });

  it("rejects a different host", () => {
    expect(redirectUriMatches(HTTPS_CALLBACK, "https://attacker.example/callback")).toBe(false);
  });

  it("rejects suffix confusion attack (attacker.com.evil.test)", () => {
    expect(redirectUriMatches(REGISTERED_HTTPS, SUFFIX_ATTACK)).toBe(false);
  });

  it("rejects userinfo injection (username)", () => {
    expect(redirectUriMatches(HTTPS_CALLBACK, USERINFO_WITH_USER)).toBe(false);
  });

  it("rejects userinfo injection (username:password)", () => {
    expect(redirectUriMatches(HTTPS_CALLBACK, USERINFO_WITH_PASS)).toBe(false);
  });

  it("ignores port on extended loopback range (127.0.0.5)", () => {
    expect(redirectUriMatches("http://127.0.0.5:1234/callback", "http://127.0.0.5:5678/callback")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter shopify-mcp-oauth test src/services/redirectUri.test.ts`
Expected: FAIL — cannot resolve `./redirectUri`.

- [ ] **Step 3: Write `src/services/redirectUri.ts`**

```ts
// RFC 8252 §3 lists 127.0.0.1 and [::1] as the canonical loopback redirect hosts. Node's
// URL.hostname keeps the IPv6 brackets, so compare against "[::1]" literally. Clients in the
// wild also use "localhost" and other 127.0.0.0/8 addresses.
function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

// RFC 3986 §3.1: scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )
const SCHEME_SHAPE = /^[a-z][a-z0-9+\-.]*$/;

// Private-use schemes are allowed (RFC 8252 §7.1), but a 302 to any of these would be a
// vulnerability: they execute script, expose local content, or hand off to arbitrary apps.
const DANGEROUS_SCHEMES = new Set([
  "javascript",
  "vbscript",
  "livescript",
  "mocha",
  "data",
  "blob",
  "file",
  "about",
  "view-source",
  "chrome",
  "chrome-extension",
  "moz-extension",
  "safari-extension",
  "jar",
  "ms-help",
  "ms-its",
  "ms-itss",
  "mhtml",
  "wyciwyg",
  "intent",
]);

export function validateRedirectUri(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return "redirect_uri must be a valid URL";
  }
  if (url.username !== "" || url.password !== "") {
    return "redirect_uri must not contain userinfo";
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (DANGEROUS_SCHEMES.has(scheme)) {
    return `${url.protocol} redirect_uris are not allowed`;
  }
  if (scheme === "https") return null;
  if (scheme === "http") {
    if (isLoopbackHost(url.hostname)) return null;
    return "http:// redirect_uris are only allowed for loopback hosts (localhost, 127.0.0.0/8, ::1)";
  }
  if (!SCHEME_SHAPE.test(scheme)) {
    return `${url.protocol} is not a valid URI scheme`;
  }
  return null;
}

// RFC 8252 §7.3: the AS MUST accept any port on a loopback redirect_uri, because native
// clients bind an ephemeral one.
export function redirectUriMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  let left: URL;
  let right: URL;
  try {
    left = new URL(registered);
    right = new URL(requested);
  } catch {
    return false;
  }
  if (left.protocol !== right.protocol) return false;
  if (left.hostname !== right.hostname) return false;
  if (left.pathname !== right.pathname) return false;
  if (left.search !== right.search) return false;
  if (left.username !== right.username || left.password !== right.password) return false;
  if (!isLoopbackHost(left.hostname)) return left.port === right.port;
  return true;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter shopify-mcp-oauth test src/services/redirectUri.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shopify-mcp-oauth/src/services/redirectUri.ts packages/shopify-mcp-oauth/src/services/redirectUri.test.ts
git commit -m "feat: add redirect_uri validation and RFC 8252 matching"
```

---

## Task 5: State JWT

**Files:**
- Create: `packages/shopify-mcp-oauth/src/services/stateJwt.ts`
- Test: `packages/shopify-mcp-oauth/src/services/stateJwt.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface OuterStatePayload { clientId, redirectUri, clientState, codeChallenge, codeChallengeMethod, resource, nonce }` — all `string`
  - `interface VerifiedOuterState extends OuterStatePayload { iat: number; exp: number }`
  - `signOuterState(payload: OuterStatePayload, secret: string, ttlSeconds: number): string`
  - `verifyOuterState(token: string, secret: string): VerifiedOuterState` — throws on tamper or expiry

The state JWT is what survives the round trip through Shopify: `/authorize` signs the client's request into it, and the callback reads it back. It is the only thing preventing an attacker from swapping the `redirect_uri` mid-flow.

- [ ] **Step 1: Write the failing test**

`src/services/stateJwt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { signOuterState, verifyOuterState, type OuterStatePayload } from "./stateJwt";

const SECRET = "test-state-secret-at-least-32-bytes-long";
const CLIENT_ID = "https://client.example/metadata.json";
const REDIRECT_URI = "https://client.example/callback";

const payload: OuterStatePayload = {
  clientId: CLIENT_ID,
  redirectUri: REDIRECT_URI,
  clientState: "client-state-value",
  codeChallenge: "challenge-value",
  codeChallengeMethod: "S256",
  resource: "https://mcp.example.com/mcp",
  nonce: "nonce-value",
};

describe("state JWT", () => {
  it("round-trips the payload", () => {
    const verified = verifyOuterState(signOuterState(payload, SECRET, 600), SECRET);
    expect(verified.clientId).toBe(CLIENT_ID);
    expect(verified.redirectUri).toBe(REDIRECT_URI);
  });

  it("rejects a token signed with a different secret", () => {
    const token = signOuterState(payload, SECRET, 600);
    expect(() => verifyOuterState(token, "a-different-secret-value-entirely")).toThrow();
  });

  it("rejects an expired token", () => {
    const token = signOuterState(payload, SECRET, -1);
    expect(() => verifyOuterState(token, SECRET)).toThrow();
  });

  it("rejects a tampered payload", () => {
    const token = signOuterState(payload, SECRET, 600);
    const [header, , signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload, redirectUri: "https://attacker.example/cb" })).toString(
      "base64url"
    );
    expect(() => verifyOuterState(`${header}.${forged}.${signature}`, SECRET)).toThrow();
  });

  it("rejects a validly signed token with wrong payload shape", () => {
    const WRONG_SHAPE_PAYLOAD = { clientId: CLIENT_ID, someOtherField: "value" };
    const token = jwt.sign(WRONG_SHAPE_PAYLOAD, SECRET, { algorithm: "HS256", expiresIn: 600 });
    expect(() => verifyOuterState(token, SECRET)).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter shopify-mcp-oauth test src/services/stateJwt.test.ts`
Expected: FAIL — cannot resolve `./stateJwt`.

- [ ] **Step 3: Write `src/services/stateJwt.ts`**

```ts
import jwt from "jsonwebtoken";
import { z } from "zod";

const outerStatePayloadSchema = z.object({
  clientId: z.string(),
  redirectUri: z.string(),
  clientState: z.string(),
  codeChallenge: z.string(),
  codeChallengeMethod: z.string(),
  resource: z.string(),
  nonce: z.string(),
});

const verifiedOuterStateSchema = outerStatePayloadSchema.extend({
  iat: z.number(),
  exp: z.number(),
});

export type OuterStatePayload = z.infer<typeof outerStatePayloadSchema>;
export type VerifiedOuterState = z.infer<typeof verifiedOuterStateSchema>;

export function signOuterState(payload: OuterStatePayload, secret: string, ttlSeconds: number): string {
  return jwt.sign(payload, secret, { algorithm: "HS256", expiresIn: ttlSeconds });
}

export function verifyOuterState(token: string, secret: string): VerifiedOuterState {
  const verified = jwt.verify(token, secret, { algorithms: ["HS256"] });
  return verifiedOuterStateSchema.parse(verified);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter shopify-mcp-oauth test src/services/stateJwt.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shopify-mcp-oauth/src/services/stateJwt.ts packages/shopify-mcp-oauth/src/services/stateJwt.test.ts
git commit -m "feat: add HS256 state JWT for the Shopify round trip"
```

---

## Task 6: Memory adapters and the storage contract suite

**Files:**
- Create: `packages/shopify-mcp-oauth/src/adapters/memoryStorage.ts`
- Create: `packages/shopify-mcp-oauth/src/adapters/memoryCache.ts`
- Create: `packages/shopify-mcp-oauth/src/testing/storageContract.ts`
- Modify: `packages/shopify-mcp-oauth/tsup.config.ts` (add the `testing` entry), `packages/shopify-mcp-oauth/package.json` (vitest as an optional peer dependency)
- Test: `packages/shopify-mcp-oauth/src/adapters/memoryStorage.test.ts`, `packages/shopify-mcp-oauth/src/adapters/memoryCache.test.ts`

**Interfaces:**
- Consumes: `OAuthStorage`, `CacheStore`, `NewOAuthClient`, `NewToken`, `StoredToken`, `ShopRef` from `../types`
- Produces:
  - `memoryStorage(seed?: { shops?: ShopRef[] }): OAuthStorage & { addShop(shop: ShopRef): void }`
  - `memoryCache(): CacheStore`
  - `runStorageContractTests(makeStorage: () => Promise<OAuthStorage> | OAuthStorage, opts: { seedShop: ShopRef }): void` — registers a `describe` block; callers invoke it inside their own test file. `seedShop` must already exist in the storage the factory returns.

`runStorageContractTests` is exported from the package's `./testing` subpath so that Vitest never
enters the main bundle.

- [ ] **Step 1: Write the failing test**

`src/adapters/memoryStorage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runStorageContractTests } from "../testing/storageContract";
import { memoryStorage } from "./memoryStorage";

const DEMO_SHOP = "example.myshopify.com";
const DEMO_SHOP_ID = "shop_1";
const MUTATION_CLIENT_ID = "mutation-test-client";
const ORIGINAL_REDIRECT_URI = "https://original.example/callback";
const INJECTED_REDIRECT_URI = "https://injected.example/callback";
const HIJACKED_SHOP_ID = "hijacked-shop-id";

runStorageContractTests(() => memoryStorage({ shops: [{ id: DEMO_SHOP_ID, domain: DEMO_SHOP }] }), {
  seedShop: { id: DEMO_SHOP_ID, domain: DEMO_SHOP },
});

describe("memoryStorage", () => {
  it("starts with no shops when given no seed", async () => {
    const storage = memoryStorage();
    expect(await storage.findShopByDomain(DEMO_SHOP)).toBeNull();
  });

  it("accepts a shop added after construction", async () => {
    const storage = memoryStorage();
    storage.addShop({ id: DEMO_SHOP_ID, domain: DEMO_SHOP });
    expect(await storage.findShopByDomain(DEMO_SHOP)).toEqual({ id: DEMO_SHOP_ID, domain: DEMO_SHOP });
  });
});

describe("memoryStorage reference isolation", () => {
  it("does not let a mutated findClient result change stored state", async () => {
    const storage = memoryStorage();
    await storage.createClient({
      clientId: MUTATION_CLIENT_ID,
      clientName: null,
      redirectUris: [ORIGINAL_REDIRECT_URI],
      grantTypes: null,
      responseTypes: null,
      logoUri: null,
      clientUri: null,
      tokenEndpointAuthMethod: "none",
    });

    const found = await storage.findClient(MUTATION_CLIENT_ID);
    found?.redirectUris.push(INJECTED_REDIRECT_URI);

    const refetched = await storage.findClient(MUTATION_CLIENT_ID);
    expect(refetched?.redirectUris).toEqual([ORIGINAL_REDIRECT_URI]);
  });

  it("does not let a mutated createClient input array change stored state", async () => {
    const storage = memoryStorage();
    const redirectUris = [ORIGINAL_REDIRECT_URI];
    await storage.createClient({
      clientId: MUTATION_CLIENT_ID,
      clientName: null,
      redirectUris,
      grantTypes: null,
      responseTypes: null,
      logoUri: null,
      clientUri: null,
      tokenEndpointAuthMethod: "none",
    });

    redirectUris.push(INJECTED_REDIRECT_URI);

    const found = await storage.findClient(MUTATION_CLIENT_ID);
    expect(found?.redirectUris).toEqual([ORIGINAL_REDIRECT_URI]);
  });

  it("does not let a mutated seeded ShopRef change what findShopByDomain returns", async () => {
    const seededShop = { id: DEMO_SHOP_ID, domain: DEMO_SHOP };
    const storage = memoryStorage({ shops: [seededShop] });

    seededShop.id = HIJACKED_SHOP_ID;

    const found = await storage.findShopByDomain(DEMO_SHOP);
    expect(found?.id).toBe(DEMO_SHOP_ID);
  });

  it("keeps a token reference held across revokeToken consistent with a fresh read", async () => {
    const storage = memoryStorage({ shops: [{ id: DEMO_SHOP_ID, domain: DEMO_SHOP }] });
    const token = await storage.createToken({
      shopId: DEMO_SHOP_ID,
      shopDomain: DEMO_SHOP,
      clientId: MUTATION_CLIENT_ID,
      accessTokenHash: "access-hash-for-revoke-consistency",
      refreshTokenHash: "refresh-hash-for-revoke-consistency",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
      scope: "mcp:*",
      resource: "https://mcp.example.com/mcp",
      rotatedFromId: null,
    });

    await storage.revokeToken(token.id);

    // A held reference is a frozen snapshot from before the revoke, matching real database
    // snapshot semantics — a caller must re-fetch to observe the storage's current state.
    expect(token.revokedAt).toBeNull();

    const refetched = await storage.findTokenByAccessHash("access-hash-for-revoke-consistency");
    expect(refetched).toBeNull();
  });
});
```

`src/adapters/memoryCache.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runCacheContractTests } from "../testing/cacheContract";
import { memoryCache } from "./memoryCache";

const KEY = "mcp:oauth:code:abc";

runCacheContractTests(() => memoryCache());

describe("memoryCache", () => {
  it("returns null for a key it never stored", async () => {
    expect(await memoryCache().get(KEY)).toBeNull();
  });

  it("returns a stored value", async () => {
    const cache = memoryCache();
    await cache.set(KEY, "stored-value", 60);
    expect(await cache.get(KEY)).toBe("stored-value");
  });

  it("rejects a non-positive ttl", async () => {
    const cache = memoryCache();
    await expect(cache.set(KEY, "stored-value", 0)).rejects.toThrow();
    await expect(cache.set(KEY, "stored-value", -1)).rejects.toThrow();
  });

  it("deletes a value", async () => {
    const cache = memoryCache();
    await cache.set(KEY, "stored-value", 60);
    await cache.del(KEY);
    expect(await cache.get(KEY)).toBeNull();
  });

  it("reads and deletes atomically via getdel", async () => {
    const cache = memoryCache();
    await cache.set(KEY, "stored-value", 60);
    expect(await cache.getdel(KEY)).toBe("stored-value");
    expect(await cache.get(KEY)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter shopify-mcp-oauth test src/adapters`
Expected: FAIL — cannot resolve `./memoryStorage`, `./memoryCache`, `../testing/storageContract`.

- [ ] **Step 3: Write `src/testing/storageContract.ts`**

```ts
import { beforeEach, describe, expect, it } from "vitest";
import type { NewOAuthClient, NewToken, OAuthStorage, ShopRef } from "../types";

const CONTRACT_CLIENT_ID = "contract-client-id";
const CONTRACT_REDIRECT_URI = "https://client.example/callback";

function buildClient(overrides: Partial<NewOAuthClient> = {}): NewOAuthClient {
  return {
    clientId: CONTRACT_CLIENT_ID,
    clientName: null,
    redirectUris: [CONTRACT_REDIRECT_URI],
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    logoUri: null,
    clientUri: null,
    tokenEndpointAuthMethod: "none",
    ...overrides,
  };
}

function buildToken(shop: ShopRef, overrides: Partial<NewToken> = {}): NewToken {
  return {
    shopId: shop.id,
    shopDomain: shop.domain,
    clientId: CONTRACT_CLIENT_ID,
    accessTokenHash: "access-hash",
    refreshTokenHash: "refresh-hash",
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
    scope: "mcp:*",
    resource: "https://mcp.example.com/mcp",
    rotatedFromId: null,
    ...overrides,
  };
}

export function runStorageContractTests(
  makeStorage: () => Promise<OAuthStorage> | OAuthStorage,
  opts: { seedShop: ShopRef }
): void {
  describe("OAuthStorage contract", () => {
    let storage: OAuthStorage;

    beforeEach(async () => {
      storage = await makeStorage();
    });

    it("returns null for an unknown client", async () => {
      expect(await storage.findClient("no-such-client")).toBeNull();
    });

    it("round-trips a created client", async () => {
      await storage.createClient(buildClient({ clientName: "Contract Client", redirectUris: [CONTRACT_REDIRECT_URI] }));
      const found = await storage.findClient(CONTRACT_CLIENT_ID);
      expect(found?.clientName).toBe("Contract Client");
      expect(found?.redirectUris).toEqual([CONTRACT_REDIRECT_URI]);
    });

    it("upsertClient is idempotent on clientId", async () => {
      await storage.upsertClient(buildClient({ clientName: "First Write" }));
      await storage.upsertClient(buildClient({ clientName: "Second Write" }));
      const found = await storage.findClient(CONTRACT_CLIENT_ID);
      expect(found?.clientName).toBe("First Write");
    });

    it("finds a token by its access hash", async () => {
      await storage.createToken(
        buildToken(opts.seedShop, { accessTokenHash: "lookup-me", clientId: CONTRACT_CLIENT_ID })
      );
      const found = await storage.findTokenByAccessHash("lookup-me");
      expect(found?.clientId).toBe(CONTRACT_CLIENT_ID);
    });

    it("returns null for an access hash that was never stored", async () => {
      expect(await storage.findTokenByAccessHash("never-stored-access-hash")).toBeNull();
    });

    it("does not return an expired access token", async () => {
      await storage.createToken(
        buildToken(opts.seedShop, {
          accessTokenHash: "expired-hash",
          accessTokenExpiresAt: new Date(Date.now() - 1000),
        })
      );
      expect(await storage.findTokenByAccessHash("expired-hash")).toBeNull();
    });

    it("does not return a revoked token by its access hash", async () => {
      const token = await storage.createToken(buildToken(opts.seedShop, { accessTokenHash: "revoke-me" }));
      await storage.revokeToken(token.id);
      expect(await storage.findTokenByAccessHash("revoke-me")).toBeNull();
    });

    it("findTokenByAccessHashIgnoringExpiry finds an expired-but-unrevoked token", async () => {
      await storage.createToken(
        buildToken(opts.seedShop, {
          accessTokenHash: "expired-but-revocable-hash",
          accessTokenExpiresAt: new Date(Date.now() - 1000),
        })
      );
      const found = await storage.findTokenByAccessHashIgnoringExpiry("expired-but-revocable-hash");
      expect(found?.accessTokenHash).toBe("expired-but-revocable-hash");
    });

    it("findTokenByAccessHashIgnoringExpiry does not return a revoked token", async () => {
      const token = await storage.createToken(
        buildToken(opts.seedShop, { accessTokenHash: "revoke-me-ignoring-expiry" })
      );
      await storage.revokeToken(token.id);
      expect(await storage.findTokenByAccessHashIgnoringExpiry("revoke-me-ignoring-expiry")).toBeNull();
    });

    it("findTokenByAccessHashIgnoringExpiry returns null for a hash that was never stored", async () => {
      expect(await storage.findTokenByAccessHashIgnoringExpiry("never-stored-access-hash")).toBeNull();
    });

    it("finds a token by its refresh hash", async () => {
      await storage.createToken(
        buildToken(opts.seedShop, { refreshTokenHash: "refresh-lookup", clientId: CONTRACT_CLIENT_ID })
      );
      const found = await storage.findTokenByRefreshHash("refresh-lookup");
      expect(found?.clientId).toBe(CONTRACT_CLIENT_ID);
    });

    it("returns null for a refresh hash that was never stored", async () => {
      expect(await storage.findTokenByRefreshHash("never-stored-refresh-hash")).toBeNull();
    });

    it("does not return an expired refresh token", async () => {
      await storage.createToken(
        buildToken(opts.seedShop, {
          refreshTokenHash: "expired-refresh-hash",
          refreshTokenExpiresAt: new Date(Date.now() - 1000),
        })
      );
      expect(await storage.findTokenByRefreshHash("expired-refresh-hash")).toBeNull();
    });

    it("does not return a revoked token by its refresh hash", async () => {
      const token = await storage.createToken(buildToken(opts.seedShop, { refreshTokenHash: "revoke-refresh-me" }));
      await storage.revokeToken(token.id);
      expect(await storage.findTokenByRefreshHash("revoke-refresh-me")).toBeNull();
    });

    it("revokeToken returns false the second time, so rotation stays single-use", async () => {
      const token = await storage.createToken(buildToken(opts.seedShop));
      expect(await storage.revokeToken(token.id)).toBe(true);
      expect(await storage.revokeToken(token.id)).toBe(false);
    });

    it("revokeToken returns false for a token id that was never created", async () => {
      expect(await storage.revokeToken("never-created-token-id")).toBe(false);
    });

    it("touchToken does not throw for an existing token", async () => {
      const token = await storage.createToken(buildToken(opts.seedShop));
      // No expect(): StoredToken has no lastUsedAt field, so resolving without throwing
      // is the only behavior this interface exposes for touchToken.
      await storage.touchToken(token.id, new Date());
    });

    it("finds the seeded shop by domain", async () => {
      const found = await storage.findShopByDomain(opts.seedShop.domain);
      expect(found?.domain).toBe(opts.seedShop.domain);
    });

    it("returns null for an unknown shop domain", async () => {
      expect(await storage.findShopByDomain("never-installed.myshopify.com")).toBeNull();
    });
  });
}
```

- [ ] **Step 4: Write `src/adapters/memoryCache.ts`**

```ts
import type { CacheStore } from "../types";

interface Entry {
  value: string;
  expiresAt: number;
}

export function memoryCache(): CacheStore {
  const entries = new Map<string, Entry>();

  function read(key: string): string | null {
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      entries.delete(key);
      return null;
    }
    return entry.value;
  }

  return {
    async get(key) {
      return read(key);
    },
    async set(key, value, ttlSeconds) {
      // Matches real Redis's "ERR invalid expire time" rather than silently storing an
      // already-expired entry, so a caller's own positive-ttl guard is load-bearing, not decorative.
      if (ttlSeconds <= 0) throw new Error("memoryCache.set: ttlSeconds must be positive");
      entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async del(key) {
      entries.delete(key);
    },
    async getdel(key) {
      const value = read(key);
      entries.delete(key);
      return value;
    },
  };
}
```

- [ ] **Step 5: Write `src/adapters/memoryStorage.ts`**

```ts
import { randomBase64Url } from "../crypto";
import type { NewOAuthClient, NewToken, OAuthClient, OAuthStorage, ShopRef, StoredToken } from "../types";

export interface MemoryStorage extends OAuthStorage {
  addShop(shop: ShopRef): void;
}

// Every read and write below goes through these clones so the Map never shares an array,
// Date, or ShopRef instance with a caller — a caller mutating a returned or passed-in object
// must never corrupt what's stored, and vice versa.
function cloneShop(shop: ShopRef): ShopRef {
  return { ...shop };
}

function cloneClient(client: OAuthClient): OAuthClient {
  return {
    ...client,
    redirectUris: [...client.redirectUris],
    grantTypes: client.grantTypes ? [...client.grantTypes] : null,
    responseTypes: client.responseTypes ? [...client.responseTypes] : null,
    revokedAt: client.revokedAt ? new Date(client.revokedAt) : null,
  };
}

function cloneToken(token: StoredToken): StoredToken {
  return {
    ...token,
    accessTokenExpiresAt: new Date(token.accessTokenExpiresAt),
    refreshTokenExpiresAt: token.refreshTokenExpiresAt ? new Date(token.refreshTokenExpiresAt) : null,
    revokedAt: token.revokedAt ? new Date(token.revokedAt) : null,
  };
}

export function memoryStorage(seed: { shops?: ShopRef[] } = {}): MemoryStorage {
  const clients = new Map<string, OAuthClient>();
  const tokens = new Map<string, StoredToken>();
  const shops = new Map<string, ShopRef>();
  for (const shop of seed.shops ?? []) shops.set(shop.domain, cloneShop(shop));

  function isUsable(token: StoredToken): boolean {
    return token.revokedAt === null && token.accessTokenExpiresAt.getTime() > Date.now();
  }

  return {
    addShop(shop) {
      shops.set(shop.domain, cloneShop(shop));
    },

    async findClient(clientId) {
      const found = clients.get(clientId);
      return found ? cloneClient(found) : null;
    },

    async createClient(client) {
      const row: OAuthClient = cloneClient({ ...client, revokedAt: null });
      clients.set(row.clientId, row);
      return cloneClient(row);
    },

    async upsertClient(client: NewOAuthClient) {
      const existing = clients.get(client.clientId);
      if (existing) return cloneClient(existing);
      const row: OAuthClient = cloneClient({ ...client, revokedAt: null });
      clients.set(row.clientId, row);
      return cloneClient(row);
    },

    async createToken(token: NewToken) {
      const row: StoredToken = cloneToken({ ...token, id: randomBase64Url(12), revokedAt: null });
      tokens.set(row.id, row);
      return cloneToken(row);
    },

    async findTokenByAccessHash(hash) {
      for (const token of tokens.values()) {
        if (token.accessTokenHash === hash && isUsable(token)) return cloneToken(token);
      }
      return null;
    },

    async findTokenByAccessHashIgnoringExpiry(hash) {
      for (const token of tokens.values()) {
        if (token.accessTokenHash === hash && token.revokedAt === null) return cloneToken(token);
      }
      return null;
    },

    async findTokenByRefreshHash(hash) {
      for (const token of tokens.values()) {
        if (token.refreshTokenHash !== hash) continue;
        if (token.revokedAt !== null) continue;
        if (token.refreshTokenExpiresAt && token.refreshTokenExpiresAt.getTime() <= Date.now()) continue;
        return cloneToken(token);
      }
      return null;
    },

    async revokeToken(id) {
      const token = tokens.get(id);
      if (!token || token.revokedAt !== null) return false;
      tokens.set(id, { ...cloneToken(token), revokedAt: new Date() });
      return true;
    },

    async touchToken() {
      // last-used tracking is not useful in memory; the contract only requires it not to throw
    },

    async findShopByDomain(domain) {
      const found = shops.get(domain);
      return found ? cloneShop(found) : null;
    },
  };
}
```

Without these clones the adapter hands out live references to its own `Map` rows: mutating a
returned client, or the array passed into `createClient`, silently corrupts the store with no
second write. No SQL-backed adapter can behave that way — rows are deserialized fresh on every
read — so a bug of that shape would surface only against this adapter, as action-at-a-distance.
Reference-isolation tests belong in `memoryStorage.test.ts`, **not** in the shared contract
suite: identity is a property of this adapter, and asserting it in the contract would wrongly
constrain the Prisma adapter in Task 8.

- [ ] **Step 6: Publish the `./testing` subpath and externalize vitest**

`src/testing/storageContract.ts` is the first file to enter the build, so wire its entry here —
Task 1 built the index alone because this file did not exist yet.

`packages/shopify-mcp-oauth/tsup.config.ts` — add the second entry:

```ts
  entry: { index: "src/index.ts", testing: "src/testing/storageContract.ts" },
```

`packages/shopify-mcp-oauth/package.json` — vitest must become an **optional peer dependency**:

```json
  "peerDependencies": {
    "express": ">=5",
    "zod": ">=3.23",
    "vitest": ">=2.0"
  },
  "peerDependenciesMeta": {
    "vitest": { "optional": true }
  }
```

Keep `vitest` in `devDependencies` as well — this package still runs its own suite.

This is not bookkeeping. tsup externalizes `dependencies` and `peerDependencies` but **bundles**
`devDependencies`, so with vitest listed only as a dev dependency the build inlines a private
copy of it into `dist/testing.js` — roughly 545KB, and worse, the `describe`/`it`/`expect` an
adopter imports would be a different module instance from the vitest actually running their
suite, so the contract tests would never register. Optional, because an adopter who imports only
the main entry never needs vitest installed.

Verify: `pnpm --filter shopify-mcp-oauth build`, then confirm `dist/testing.js` is a few KB and
contains an `import ... from "vitest"` rather than a bundled definition of `describe`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter shopify-mcp-oauth test src/adapters`
Expected: PASS — the contract suite runs once against `memoryStorage`, plus the `memoryCache`
tests and the `memoryStorage` reference-isolation tests.

- [ ] **Step 8: Commit**

```bash
git add packages/shopify-mcp-oauth/src/adapters packages/shopify-mcp-oauth/src/testing \
  packages/shopify-mcp-oauth/tsup.config.ts packages/shopify-mcp-oauth/package.json
git commit -m "feat: add memory storage and cache adapters with a storage contract suite"
```

---

## Task 7: Redis cache adapter

**Files:**
- Create: `packages/shopify-mcp-oauth/src/adapters/redisCache.ts`
- Test: `packages/shopify-mcp-oauth/src/adapters/redisCache.test.ts`

**Interfaces:**
- Consumes: `CacheStore` from `../types`
- Produces:
  - `interface RedisLikeClient { get(key): Promise<string | null>; set(key, value, opts: { EX: number }): Promise<unknown>; del(key): Promise<unknown>; getDel?(key): Promise<string | null> }`
  - `redisCache(client: RedisLikeClient): CacheStore`

Typed against a minimal structural interface rather than a specific client, so `node-redis` and
`ioredis` wrappers both satisfy it without the package depending on either.

- [ ] **Step 1: Write the failing test**

`src/adapters/redisCache.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { runCacheContractTests } from "../testing/cacheContract";
import { redisCache, type RedisLikeClient } from "./redisCache";

const KEY = "mcp:oauth:code:abc";

function buildFakeRedis(overrides: Partial<RedisLikeClient> = {}): RedisLikeClient {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    getDel: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

// Backed by a real map with EX semantics, unlike buildFakeRedis's canned responses — the shared
// cache contract needs a client whose state actually mutates across calls, and whose getDel is
// genuinely atomic, to exercise get/set/del/ttl/exclusivity meaningfully.
function buildStatefulFakeRedis(): RedisLikeClient {
  const entries = new Map<string, { value: string; expiresAt: number }>();

  function read(key: string): string | null {
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      entries.delete(key);
      return null;
    }
    return entry.value;
  }

  return {
    async get(key) {
      return read(key);
    },
    async set(key, value, opts) {
      // Mirrors real Redis's "ERR invalid expire time in 'set' command" — a fake that's more
      // permissive than production here would let the contract's rejection clause pass for the
      // wrong reason.
      if (opts.EX <= 0) throw new Error("ERR invalid expire time in 'set' command");
      entries.set(key, { value, expiresAt: Date.now() + opts.EX * 1000 });
    },
    async del(key) {
      entries.delete(key);
    },
    async getDel(key) {
      const value = read(key);
      entries.delete(key);
      return value;
    },
  };
}

runCacheContractTests(() => redisCache(buildStatefulFakeRedis()));

describe("redisCache", () => {
  it("sets with an EX ttl", async () => {
    const client = buildFakeRedis();
    await redisCache(client).set(KEY, "stored-value", 60);
    expect(client.set).toHaveBeenCalledWith(KEY, "stored-value", { EX: 60 });
  });

  it("reads a stored value", async () => {
    const client = buildFakeRedis({ get: vi.fn().mockResolvedValue("stored-value") });
    expect(await redisCache(client).get(KEY)).toBe("stored-value");
  });

  it("delegates getdel to the client's native getDel", async () => {
    const getDel = vi.fn().mockResolvedValue("stored-value");
    const client = buildFakeRedis({ getDel });
    expect(await redisCache(client).getdel(KEY)).toBe("stored-value");
    expect(getDel).toHaveBeenCalledWith(KEY);
  });
});

// Type-only regression guard: a client without a native getDel must not satisfy RedisLikeClient —
// the get+del fallback that optionality used to permit was not atomic, making a redeemed
// authorization code replayable under concurrent requests. Declared but never called; exists
// solely for `pnpm typecheck` to catch a regression if getDel is ever made optional again.
function clientWithoutGetDelIsRejected(): void {
  const clientMissingGetDel = {
    get: async () => null,
    set: async () => undefined,
    del: async () => undefined,
  };
  // @ts-expect-error getDel is required — a client without it must not satisfy RedisLikeClient
  const client: RedisLikeClient = clientMissingGetDel;
  void client;
}
void clientWithoutGetDelIsRejected;
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter shopify-mcp-oauth test src/adapters/redisCache.test.ts`
Expected: FAIL — cannot resolve `./redisCache`.

- [ ] **Step 3: Write `src/adapters/redisCache.ts`**

```ts
import type { CacheStore } from "../types";

/**
 * Shaped after node-redis v4: `getDel` casing, `set(key, value, { EX })`. `getDel` is required,
 * not optional — this adapter needs node-redis ≥4 talking to Redis ≥6.2 (the GETDEL command it
 * wraps), because a get-then-del fallback is not atomic: two concurrent redemptions of one
 * authorization code could both read it before either delete lands, making the code replayable.
 * Requiring it here narrows compatibility no further than this interface already does.
 */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts: { EX: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
  getDel(key: string): Promise<string | null>;
}

export function redisCache(client: RedisLikeClient): CacheStore {
  return {
    async get(key) {
      return client.get(key);
    },
    async set(key, value, ttlSeconds) {
      await client.set(key, value, { EX: ttlSeconds });
    },
    async del(key) {
      await client.del(key);
    },
    async getdel(key) {
      return client.getDel(key);
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter shopify-mcp-oauth test src/adapters/redisCache.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shopify-mcp-oauth/src/adapters/redisCache.ts packages/shopify-mcp-oauth/src/adapters/redisCache.test.ts
git commit -m "feat: add redis cache adapter"
```

---

## Task 8: Prisma storage adapter

**Files:**
- Create: `packages/shopify-mcp-oauth/src/adapters/prismaStorage.ts`
- Test: `packages/shopify-mcp-oauth/src/adapters/prismaStorage.test.ts`

**Interfaces:**
- Consumes: `OAuthStorage`, `NewOAuthClient`, `NewToken`, `OAuthClient`, `StoredToken`, `ShopRef` from `../types`
- Produces:
  - `interface PrismaShopMapping { model: string; domainField: string; idField: string; where?: Record<string, unknown> }`
  - `prismaStorage(prisma: PrismaLikeClient): Omit<OAuthStorage, "findShopByDomain">`
  - `prismaStorage(prisma: PrismaLikeClient, opts: { shop: PrismaShopMapping }): OAuthStorage`

The overload is the enforcement mechanism from the spec: omitting `shop` yields a type that is
missing `findShopByDomain`, so a config without a shop lookup fails to compile rather than failing at
runtime. The adopter supplies the lookup some other way — `shopifySessionStorage` or `allowAnyShop`.

The adapter is typed against a minimal structural `PrismaLikeClient` so the package never depends on
`@prisma/client`, and the tests can pass a plain object.

- [ ] **Step 1: Write the failing test**

`src/adapters/prismaStorage.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { prismaStorage, type PrismaLikeClient } from "./prismaStorage";
import type { NewOAuthClient, NewToken } from "../types";

const DEMO_SHOP = "example.myshopify.com";
const CLIENT_ID = "prisma-client-id";
const TOKEN_ID = "token-1";
const LAST_USED_AT = new Date("2026-01-15T12:00:00.000Z");

function buildPrisma(overrides: Record<string, unknown> = {}): PrismaLikeClient {
  return {
    mcpOAuthClient: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(null),
    },
    mcpOAuthToken: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    ...overrides,
  } as unknown as PrismaLikeClient;
}

describe("prismaStorage", () => {
  it("maps a client row into the OAuthClient shape", async () => {
    const prisma = buildPrisma({
      mcpOAuthClient: {
        findFirst: vi.fn().mockResolvedValue({
          clientId: CLIENT_ID,
          clientName: "Prisma Client",
          redirectUris: ["https://client.example/callback"],
          grantTypes: ["authorization_code"],
          responseTypes: ["code"],
          logoUri: null,
          clientUri: null,
          tokenEndpointAuthMethod: "none",
          revokedAt: null,
        }),
        create: vi.fn(),
        upsert: vi.fn(),
      },
    });
    const found = await prismaStorage(prisma).findClient(CLIENT_ID);
    expect(found?.clientName).toBe("Prisma Client");
  });

  it("passes client fields through to create and maps the returned row back", async () => {
    const newClient: NewOAuthClient = {
      clientId: CLIENT_ID,
      clientName: "Created Client",
      redirectUris: ["https://created.example/callback"],
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      logoUri: null,
      clientUri: null,
      tokenEndpointAuthMethod: "none",
    };
    const create = vi.fn().mockResolvedValue({ ...newClient, revokedAt: null });
    const prisma = buildPrisma({
      mcpOAuthClient: { findFirst: vi.fn(), create, upsert: vi.fn() },
    });
    const created = await prismaStorage(prisma).createClient(newClient);
    expect(create).toHaveBeenCalledWith({ data: newClient });
    expect(created.clientId).toBe(CLIENT_ID);
  });

  it("upsertClient sends an empty update, matching insert-if-absent semantics", async () => {
    const newClient: NewOAuthClient = {
      clientId: CLIENT_ID,
      clientName: "Upserted Client",
      redirectUris: ["https://client.example/callback"],
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      logoUri: null,
      clientUri: null,
      tokenEndpointAuthMethod: "none",
    };
    const upsert = vi.fn().mockResolvedValue({ ...newClient, revokedAt: null });
    const prisma = buildPrisma({
      mcpOAuthClient: { findFirst: vi.fn(), create: vi.fn(), upsert },
    });
    await prismaStorage(prisma).upsertClient(newClient);
    const call = upsert.mock.calls[0]?.[0];
    expect(call.where).toEqual({ clientId: CLIENT_ID });
    expect(call.update).toEqual({});
  });

  it("passes token fields through to create and maps the returned row back", async () => {
    const newToken: NewToken = {
      shopId: "shop_1",
      shopDomain: DEMO_SHOP,
      clientId: CLIENT_ID,
      accessTokenHash: "access-hash-created",
      refreshTokenHash: "refresh-hash-created",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
      scope: "mcp:*",
      resource: "https://mcp.example.com/mcp",
      rotatedFromId: null,
    };
    const create = vi.fn().mockResolvedValue({ ...newToken, id: "token-row-1", revokedAt: null });
    const prisma = buildPrisma({
      mcpOAuthToken: { findFirst: vi.fn(), create, updateMany: vi.fn() },
    });
    const created = await prismaStorage(prisma).createToken(newToken);
    expect(create).toHaveBeenCalledWith({ data: newToken });
    expect(created.clientId).toBe(CLIENT_ID);
  });

  it("filters expired and revoked rows in the access-hash lookup", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = buildPrisma({
      mcpOAuthToken: { findFirst, create: vi.fn(), updateMany: vi.fn() },
    });
    await prismaStorage(prisma).findTokenByAccessHash("some-hash");
    const where = findFirst.mock.calls[0]?.[0]?.where;
    expect(where.accessTokenHash).toBe("some-hash");
    expect(where.revokedAt).toBeNull();
    expect(where.accessTokenExpiresAt.gt).toBeInstanceOf(Date);
  });

  it("ignores expiry but still filters revoked rows in the revocation access-hash lookup", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = buildPrisma({
      mcpOAuthToken: { findFirst, create: vi.fn(), updateMany: vi.fn() },
    });
    await prismaStorage(prisma).findTokenByAccessHashIgnoringExpiry("some-hash");
    const where = findFirst.mock.calls[0]?.[0]?.where;
    expect(where.accessTokenHash).toBe("some-hash");
    expect(where.revokedAt).toBeNull();
    expect(where.accessTokenExpiresAt).toBeUndefined();
  });

  it("filters expired and revoked rows in the refresh-hash lookup", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = buildPrisma({
      mcpOAuthToken: { findFirst, create: vi.fn(), updateMany: vi.fn() },
    });
    await prismaStorage(prisma).findTokenByRefreshHash("some-refresh-hash");
    const where = findFirst.mock.calls[0]?.[0]?.where;
    expect(where.refreshTokenHash).toBe("some-refresh-hash");
    expect(where.revokedAt).toBeNull();
    expect(where.refreshTokenExpiresAt.gt).toBeInstanceOf(Date);
  });

  it("revokeToken reports false when no unrevoked row matched", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = buildPrisma({
      mcpOAuthToken: { findFirst: vi.fn(), create: vi.fn(), updateMany },
    });
    expect(await prismaStorage(prisma).revokeToken(TOKEN_ID)).toBe(false);
    expect(updateMany.mock.calls[0]?.[0]?.where).toEqual({ id: TOKEN_ID, revokedAt: null });
  });

  it("revokeToken reports true when one row flipped", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = buildPrisma({
      mcpOAuthToken: { findFirst: vi.fn(), create: vi.fn(), updateMany },
    });
    expect(await prismaStorage(prisma).revokeToken(TOKEN_ID)).toBe(true);
    const call = updateMany.mock.calls[0]?.[0];
    expect(call.where).toEqual({ id: TOKEN_ID, revokedAt: null });
    expect(call.data.revokedAt).toBeInstanceOf(Date);
  });

  it("touchToken does not throw when the delegate has no updateMany", async () => {
    const prisma = buildPrisma({
      mcpOAuthToken: { findFirst: vi.fn(), create: vi.fn(), updateMany: undefined },
    });
    await expect(prismaStorage(prisma).touchToken(TOKEN_ID, new Date())).resolves.toBeUndefined();
  });

  it("touchToken sends the id and lastUsedAt to updateMany", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = buildPrisma({
      mcpOAuthToken: { findFirst: vi.fn(), create: vi.fn(), updateMany },
    });
    await prismaStorage(prisma).touchToken(TOKEN_ID, LAST_USED_AT);
    const call = updateMany.mock.calls[0]?.[0];
    expect(call.where).toEqual({ id: TOKEN_ID });
    expect(call.data.lastUsedAt).toBe(LAST_USED_AT);
  });

  it("looks the shop up through the configured mapping", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "store_7", myshopifyDomain: DEMO_SHOP });
    const prisma = buildPrisma({ store: { findFirst } });
    const storage = prismaStorage(prisma, {
      shop: { model: "store", domainField: "myshopifyDomain", idField: "id" },
    });
    expect(await storage.findShopByDomain(DEMO_SHOP)).toEqual({ id: "store_7", domain: DEMO_SHOP });
    expect(findFirst).toHaveBeenCalledWith({ where: { myshopifyDomain: DEMO_SHOP } });
  });

  it("returns null when the mapped shop row is absent", async () => {
    const prisma = buildPrisma({ store: { findFirst: vi.fn().mockResolvedValue(null) } });
    const storage = prismaStorage(prisma, {
      shop: { model: "store", domainField: "myshopifyDomain", idField: "id" },
    });
    expect(await storage.findShopByDomain(DEMO_SHOP)).toBeNull();
  });
});

// Type-only regression guard: `prismaStorage` without a shop mapping must not expose
// `findShopByDomain`. Declared but never called — it exists solely for `pnpm typecheck` to catch a
// regression in the overload. If the overload's enforcement is ever lost, the line below stops
// producing a real error and typecheck fails on "Unused '@ts-expect-error' directive."
function unmappedStorageHasNoShopLookup(prisma: PrismaLikeClient): void {
  const storageWithoutShopMapping = prismaStorage(prisma);
  // @ts-expect-error findShopByDomain is intentionally absent without a shop mapping
  const lookup = storageWithoutShopMapping.findShopByDomain;
  void lookup;
}
void unmappedStorageHasNoShopLookup;
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter shopify-mcp-oauth test src/adapters/prismaStorage.test.ts`
Expected: FAIL — cannot resolve `./prismaStorage`.

- [ ] **Step 3: Write `src/adapters/prismaStorage.ts`**

```ts
import type { NewOAuthClient, NewToken, OAuthClient, OAuthStorage, ShopRef, StoredToken } from "../types";

interface PrismaDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<Record<string, unknown> | null>;
  create(args: { data: Record<string, unknown> }): Promise<Record<string, unknown>>;
  // Optional so a minimal delegate (e.g. a shop-mapping model that only needs findFirst) still
  // satisfies this type; callers that need them get a runtime guard instead (upsertClient/revokeToken).
  upsert?(args: {
    where: Record<string, unknown>;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  updateMany?(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

/**
 * Structural, so the adapter never imports `@prisma/client`. Declared as two named members
 * rather than an index signature: a real `PrismaClient` carries `$connect`/`$transaction`,
 * which a `Record<string, PrismaDelegate>` would reject.
 */
export interface PrismaLikeClient {
  mcpOAuthClient: PrismaDelegate;
  mcpOAuthToken: PrismaDelegate;
}

export interface PrismaShopMapping {
  model: string;
  domainField: string;
  idField: string;
  where?: Record<string, unknown>;
}

function toClient(row: Record<string, unknown>): OAuthClient {
  return {
    clientId: row.clientId as string,
    clientName: (row.clientName as string | null) ?? null,
    redirectUris: row.redirectUris as string[],
    grantTypes: (row.grantTypes as string[] | null) ?? null,
    responseTypes: (row.responseTypes as string[] | null) ?? null,
    logoUri: (row.logoUri as string | null) ?? null,
    clientUri: (row.clientUri as string | null) ?? null,
    tokenEndpointAuthMethod: (row.tokenEndpointAuthMethod as string) ?? "none",
    revokedAt: (row.revokedAt as Date | null) ?? null,
  };
}

function toToken(row: Record<string, unknown>): StoredToken {
  return {
    id: String(row.id),
    shopId: row.shopId as string | number,
    shopDomain: row.shopDomain as string,
    clientId: row.clientId as string,
    accessTokenHash: row.accessTokenHash as string,
    refreshTokenHash: (row.refreshTokenHash as string | null) ?? null,
    accessTokenExpiresAt: row.accessTokenExpiresAt as Date,
    refreshTokenExpiresAt: (row.refreshTokenExpiresAt as Date | null) ?? null,
    scope: (row.scope as string | null) ?? null,
    resource: (row.resource as string | null) ?? null,
    revokedAt: (row.revokedAt as Date | null) ?? null,
    rotatedFromId: (row.rotatedFromId as string | null) ?? null,
  };
}

function buildCore(prisma: PrismaLikeClient): Omit<OAuthStorage, "findShopByDomain"> {
  return {
    async findClient(clientId) {
      const row = await prisma.mcpOAuthClient.findFirst({ where: { clientId, revokedAt: null } });
      return row ? toClient(row) : null;
    },

    async createClient(client: NewOAuthClient) {
      const row = await prisma.mcpOAuthClient.create({ data: { ...client } });
      return toClient(row);
    },

    async upsertClient(client: NewOAuthClient) {
      if (!prisma.mcpOAuthClient.upsert) {
        throw new Error("prisma client delegate does not support upsert");
      }
      const row = await prisma.mcpOAuthClient.upsert({
        where: { clientId: client.clientId },
        create: { ...client },
        update: {},
      });
      return toClient(row);
    },

    async createToken(token: NewToken) {
      const row = await prisma.mcpOAuthToken.create({ data: { ...token } });
      return toToken(row);
    },

    async findTokenByAccessHash(hash) {
      const row = await prisma.mcpOAuthToken.findFirst({
        where: { accessTokenHash: hash, revokedAt: null, accessTokenExpiresAt: { gt: new Date() } },
      });
      return row ? toToken(row) : null;
    },

    async findTokenByAccessHashIgnoringExpiry(hash) {
      const row = await prisma.mcpOAuthToken.findFirst({ where: { accessTokenHash: hash, revokedAt: null } });
      return row ? toToken(row) : null;
    },

    async findTokenByRefreshHash(hash) {
      const row = await prisma.mcpOAuthToken.findFirst({
        where: { refreshTokenHash: hash, revokedAt: null, refreshTokenExpiresAt: { gt: new Date() } },
      });
      return row ? toToken(row) : null;
    },

    async revokeToken(id) {
      if (!prisma.mcpOAuthToken.updateMany) {
        throw new Error("prisma token delegate does not support updateMany");
      }
      // Conditional update: only the request that flips revokedAt from null wins, so two
      // concurrent refreshes cannot each mint a new pair.
      const result = await prisma.mcpOAuthToken.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return result.count > 0;
    },

    async touchToken(id, lastUsedAt) {
      await prisma.mcpOAuthToken.updateMany?.({ where: { id }, data: { lastUsedAt } });
    },
  };
}

export function prismaStorage(prisma: PrismaLikeClient): Omit<OAuthStorage, "findShopByDomain">;
export function prismaStorage(prisma: PrismaLikeClient, opts: { shop: PrismaShopMapping }): OAuthStorage;
export function prismaStorage(
  prisma: PrismaLikeClient,
  opts?: { shop: PrismaShopMapping }
): OAuthStorage | Omit<OAuthStorage, "findShopByDomain"> {
  const core = buildCore(prisma);
  if (!opts) return core;

  const mapping = opts.shop;
  return {
    ...core,
    async findShopByDomain(domain): Promise<ShopRef | null> {
      const delegate = (prisma as unknown as Record<string, PrismaDelegate | undefined>)[mapping.model];
      if (!delegate) throw new Error(`prisma client has no "${mapping.model}" model`);
      const row = await delegate.findFirst({
        where: { ...(mapping.where ?? {}), [mapping.domainField]: domain },
      });
      if (!row) return null;
      return { id: row[mapping.idField] as string | number, domain };
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter shopify-mcp-oauth test src/adapters/prismaStorage.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Pin the overload with a permanent type-only guard**

The two-overload signature is the point of this task: it turns a missing shop mapping into a
compile error instead of a runtime failure part-way through an OAuth flow. A guarantee nothing
re-checks is a comment, so the check belongs in the committed test file — not in a scratch file
that gets deleted.

Append to `src/adapters/prismaStorage.test.ts`, outside the `describe` block:

```ts
// Type-only regression guard: `prismaStorage` without a shop mapping must not expose
// `findShopByDomain`. Declared but never called — it exists solely for `pnpm typecheck` to catch a
// regression in the overload. If the overload's enforcement is ever lost, the line below stops
// producing a real error and typecheck fails on "Unused '@ts-expect-error' directive."
function unmappedStorageHasNoShopLookup(prisma: PrismaLikeClient): void {
  const storageWithoutShopMapping = prismaStorage(prisma);
  // @ts-expect-error findShopByDomain is intentionally absent without a shop mapping
  const lookup = storageWithoutShopMapping.findShopByDomain;
  void lookup;
}
void unmappedStorageHasNoShopLookup;
```

Run: `pnpm --filter shopify-mcp-oauth typecheck`
Expected: exit 0.

Then confirm the directive is catching something real, because a passing typecheck alone does not
prove it. Delete the `@ts-expect-error` line and re-run: typecheck must fail with
`TS2339: Property 'findShopByDomain' does not exist on type 'Omit<OAuthStorage, "findShopByDomain">'`.
Restore the line and confirm clean again. A directive that suppresses nothing passes just as
quietly as one that works.

- [ ] **Step 6: Commit**

```bash
git add packages/shopify-mcp-oauth/src/adapters/prismaStorage.ts packages/shopify-mcp-oauth/src/adapters/prismaStorage.test.ts
git commit -m "feat: add prisma storage adapter with an optional shop mapping"
```

---

## Task 9: Shop lookup adapters

**Files:**
- Create: `packages/shopify-mcp-oauth/src/adapters/shopifySessionStorage.ts`
- Create: `packages/shopify-mcp-oauth/src/adapters/allowAnyShop.ts`
- Test: `packages/shopify-mcp-oauth/src/adapters/shopifySessionStorage.test.ts`, `packages/shopify-mcp-oauth/src/adapters/allowAnyShop.test.ts`

**Interfaces:**
- Consumes: `ShopRef`, `OAuthStorage` from `../types`
- Produces:
  - `interface ShopifySessionLike { shop: string; isOnline: boolean; accessToken?: string }`
  - `interface ShopifySessionStorageLike { findSessionsByShop(shop: string): Promise<ShopifySessionLike[]> }`
  - `shopifySessionStorage(sessionStorage: ShopifySessionStorageLike): OAuthStorage["findShopByDomain"]`
  - `allowAnyShop(): OAuthStorage["findShopByDomain"]`

`findSessionsByShop` is a required method on `@shopify/shopify-app-session-storage`'s `SessionStorage`
interface, so every official adapter implements it — Prisma, Redis, MongoDB, MySQL, PostgreSQL,
SQLite, DynamoDB, Cloudflare KV. Binding here rather than to a table keeps the lookup independent of
where the adopter's sessions live.

- [ ] **Step 1: Write the failing tests**

`src/adapters/shopifySessionStorage.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { shopifySessionStorage, type ShopifySessionLike } from "./shopifySessionStorage";

const DEMO_SHOP = "example.myshopify.com";
const OTHER_SHOP = "other.myshopify.com";
const OFFLINE_TOKEN = "shpua_offline_token";
const EMPTY_TOKEN = "";

function buildSessionStorage(sessions: ShopifySessionLike[]) {
  return { findSessionsByShop: vi.fn().mockResolvedValue(sessions) };
}

describe("shopifySessionStorage", () => {
  it("resolves a shop that has an offline session with an access token", async () => {
    const lookup = shopifySessionStorage(
      buildSessionStorage([{ shop: DEMO_SHOP, isOnline: false, accessToken: OFFLINE_TOKEN }])
    );
    expect(await lookup(DEMO_SHOP)).toEqual({ id: DEMO_SHOP, domain: DEMO_SHOP });
  });

  it("returns null when the shop has no sessions", async () => {
    const lookup = shopifySessionStorage(buildSessionStorage([]));
    expect(await lookup(DEMO_SHOP)).toBeNull();
  });

  it("ignores online sessions, which do not carry an app-level grant", async () => {
    const lookup = shopifySessionStorage(
      buildSessionStorage([{ shop: DEMO_SHOP, isOnline: true, accessToken: OFFLINE_TOKEN }])
    );
    expect(await lookup(DEMO_SHOP)).toBeNull();
  });

  it("ignores an offline session with no access token", async () => {
    const lookup = shopifySessionStorage(buildSessionStorage([{ shop: DEMO_SHOP, isOnline: false }]));
    expect(await lookup(DEMO_SHOP)).toBeNull();
  });

  it("returns null when the session storage throws", async () => {
    const lookup = shopifySessionStorage({
      findSessionsByShop: vi.fn().mockRejectedValue(new Error("redis down")),
    });
    expect(await lookup(DEMO_SHOP)).toBeNull();
  });

  it("ignores an offline session with an empty-string access token", async () => {
    const lookup = shopifySessionStorage(
      buildSessionStorage([{ shop: DEMO_SHOP, isOnline: false, accessToken: EMPTY_TOKEN }])
    );
    expect(await lookup(DEMO_SHOP)).toBeNull();
  });

  it("returns null when a session belongs to a different shop", async () => {
    const lookup = shopifySessionStorage(
      buildSessionStorage([{ shop: OTHER_SHOP, isOnline: false, accessToken: OFFLINE_TOKEN }])
    );
    expect(await lookup(DEMO_SHOP)).toBeNull();
  });

  it("returns null when the session storage resolves a non-array", () => {
    const lookup = shopifySessionStorage({
      findSessionsByShop: vi.fn().mockResolvedValue(undefined),
    });
    return expect(lookup(DEMO_SHOP)).resolves.toBeNull();
  });

  it("resolves a qualifying session when non-qualifying ones are present", async () => {
    const lookup = shopifySessionStorage(
      buildSessionStorage([
        { shop: DEMO_SHOP, isOnline: true, accessToken: OFFLINE_TOKEN },
        { shop: OTHER_SHOP, isOnline: false, accessToken: OFFLINE_TOKEN },
        { shop: DEMO_SHOP, isOnline: false, accessToken: OFFLINE_TOKEN },
      ])
    );
    expect(await lookup(DEMO_SHOP)).toEqual({ id: DEMO_SHOP, domain: DEMO_SHOP });
  });
});
```

`src/adapters/allowAnyShop.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { allowAnyShop } from "./allowAnyShop";

const ANY_SHOP = "never-installed.myshopify.com";

describe("allowAnyShop", () => {
  it("resolves every domain, keyed by the domain itself", async () => {
    expect(await allowAnyShop()(ANY_SHOP)).toEqual({ id: ANY_SHOP, domain: ANY_SHOP });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter shopify-mcp-oauth test src/adapters/shopifySessionStorage.test.ts src/adapters/allowAnyShop.test.ts`
Expected: FAIL — cannot resolve either module.

- [ ] **Step 3: Write `src/adapters/shopifySessionStorage.ts`**

```ts
import type { OAuthStorage, ShopRef } from "../types";

export interface ShopifySessionLike {
  shop: string;
  isOnline: boolean;
  accessToken?: string;
}

export interface ShopifySessionStorageLike {
  findSessionsByShop(shop: string): Promise<ShopifySessionLike[]>;
}

export function shopifySessionStorage(sessionStorage: ShopifySessionStorageLike): OAuthStorage["findShopByDomain"] {
  return async (domain: string): Promise<ShopRef | null> => {
    try {
      const sessions = await sessionStorage.findSessionsByShop(domain);
      // ShopifySessionStorageLike is structural, so the return type is not enforced at runtime.
      if (!Array.isArray(sessions)) {
        return null;
      }
      // The shop check is not redundant with querying by domain: a custom session-store wrapper
      // that filters loosely would otherwise let one shop's grant authorize another's. Only an
      // offline session proves an app-level grant — online sessions are per-staff-member.
      const offline = sessions.find(
        (session) => session.shop === domain && !session.isOnline && Boolean(session.accessToken)
      );
      return offline ? { id: domain, domain } : null;
    } catch {
      // A session-store outage must read as "not installed", never as "installed".
      return null;
    }
  };
}
```

Two things here are load-bearing and were both wrong in an earlier draft of this plan.

`session.shop === domain` looks redundant beside a query that already takes the domain, which is
exactly how it gets deleted. It is not redundant: `ShopifySessionStorageLike` is a **structural**
interface, so any adopter object with a matching method shape satisfies it — including a wrapper
that filters loosely or caches by prefix. Without the check, a session belonging to shop B
authorizes shop A. This function is the package's authorization boundary; it must verify identity
rather than inherit it from its caller.

The whole lookup sits inside the `try` for the same reason. If `findSessionsByShop` *resolves* a
non-array rather than rejecting, calling `.find` on it throws, and the function returns a rejected
promise instead of `null` — breaking the fail-closed guarantee the comment claims.

- [ ] **Step 4: Write `src/adapters/allowAnyShop.ts`**

```ts
import type { OAuthStorage, ShopRef } from "../types";

/**
 * Removes the install gate: any merchant who completes Shopify's flow receives a token.
 * Shopify installs the app on approval, so finishing the flow does not prove prior install.
 * Only use this when the app genuinely keeps no per-shop record.
 */
export function allowAnyShop(): OAuthStorage["findShopByDomain"] {
  return async (domain: string): Promise<ShopRef | null> => ({ id: domain, domain });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter shopify-mcp-oauth test src/adapters/shopifySessionStorage.test.ts src/adapters/allowAnyShop.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/shopify-mcp-oauth/src/adapters/shopifySessionStorage.ts packages/shopify-mcp-oauth/src/adapters/shopifySessionStorage.test.ts packages/shopify-mcp-oauth/src/adapters/allowAnyShop.ts packages/shopify-mcp-oauth/src/adapters/allowAnyShop.test.ts
git commit -m "feat: resolve shops through Shopify's SessionStorage interface"
```

---

## Task 10: Config resolution

**Files:**
- Create: `packages/shopify-mcp-oauth/src/config.ts`
- Test: `packages/shopify-mcp-oauth/src/config.test.ts`

**Interfaces:**
- Consumes: `OAuthStorage`, `CacheStore`, `Logger` from `./types`; `memoryCache` from `./adapters/memoryCache`
- Produces: `ShopifyMcpOAuthConfig`, `ResolvedConfig`, `resolveConfig(input): ResolvedConfig` — exactly as written in **Locked Interfaces**

Config errors throw at construction, naming the field. A server that boots with a bad `host` and only
fails during a merchant's login is far worse than one that refuses to start.

- [ ] **Step 1: Write the failing test**

`src/config.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { memoryCache } from "./adapters/memoryCache";
import { memoryStorage } from "./adapters/memoryStorage";
import { resolveConfig, type ShopifyMcpOAuthConfig } from "./config";

const HOST = "https://mcp.example.com";
const STATE_SECRET = "test-state-secret-at-least-32-bytes-long";

// Silent by default so the no-cache warning does not spray stderr across every case that isn't
// about it. The two tests that assert the warning pass their own spy logger.
const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function buildConfig(overrides: Partial<ShopifyMcpOAuthConfig> = {}): ShopifyMcpOAuthConfig {
  return {
    host: HOST,
    shopify: { apiKey: "test-api-key", apiSecret: "test-api-secret", scopes: "read_products" },
    stateSecret: STATE_SECRET,
    storage: memoryStorage(),
    logger: silentLogger,
    ...overrides,
  };
}

describe("resolveConfig", () => {
  it("derives the canonical resource identifier from the host", () => {
    expect(resolveConfig(buildConfig({ host: HOST })).resource).toBe(`${HOST}/mcp`);
  });

  it("strips a trailing slash from the host", () => {
    expect(resolveConfig(buildConfig({ host: `${HOST}/` })).host).toBe(HOST);
  });

  it("defaults the access token TTL to one hour", () => {
    expect(resolveConfig(buildConfig()).tokenTtl.access).toBe(3600);
  });

  it("defaults the refresh token TTL to thirty days", () => {
    expect(resolveConfig(buildConfig()).tokenTtl.refresh).toBe(2_592_000);
  });

  it("keeps an explicit access TTL", () => {
    expect(resolveConfig(buildConfig({ tokenTtl: { access: 900 } })).tokenTtl.access).toBe(900);
  });

  it("defaults the register rate limit to 20 per hour", () => {
    expect(resolveConfig(buildConfig()).registerRateLimit).toEqual({ limit: 20, windowMs: 3_600_000 });
  });

  it("supplies a memory cache when none is given", () => {
    expect(resolveConfig(buildConfig()).cache).toBeDefined();
  });

  it("rejects a host that is not an absolute URL", () => {
    expect(() => resolveConfig(buildConfig({ host: "mcp.example.com" }))).toThrow(/host/);
  });

  it("rejects a host with a query string", () => {
    expect(() => resolveConfig(buildConfig({ host: `${HOST}?x=1` }))).toThrow(/host/);
  });

  it("rejects a host with a fragment", () => {
    expect(() => resolveConfig(buildConfig({ host: `${HOST}#frag` }))).toThrow(/host/);
  });

  it("rejects a host with no hostname", () => {
    expect(() => resolveConfig(buildConfig({ host: "https:///" }))).toThrow(/host/);
  });

  it("rejects a host with a username and password", () => {
    expect(() => resolveConfig(buildConfig({ host: "https://user:pass@mcp.example.com" }))).toThrow(/host/);
  });

  it("rejects a host with just a username", () => {
    expect(() => resolveConfig(buildConfig({ host: "https://attacker@mcp.example.com" }))).toThrow(/host/);
  });

  it("keeps a base path when deriving the resource", () => {
    expect(resolveConfig(buildConfig({ host: `${HOST}/base` })).resource).toBe(`${HOST}/base/mcp`);
  });

  it("lowercases an uppercase host", () => {
    expect(resolveConfig(buildConfig({ host: "HTTPS://MCP.EXAMPLE.COM" })).resource).toBe(`${HOST}/mcp`);
  });

  it("drops an explicit default port", () => {
    expect(resolveConfig(buildConfig({ host: `${HOST}:443` })).resource).toBe(`${HOST}/mcp`);
  });

  it("produces a single slash before mcp for a plain host with no path", () => {
    const resolved = resolveConfig(buildConfig({ host: HOST }));
    expect(resolved.host).toBe(HOST);
    expect(resolved.resource).toBe(`${HOST}/mcp`);
  });

  it("rejects a state secret shorter than 32 characters", () => {
    expect(() => resolveConfig(buildConfig({ stateSecret: "too-short" }))).toThrow(/stateSecret/);
  });

  it("rejects a missing Shopify api secret", () => {
    const config = buildConfig({ shopify: { apiKey: "test-api-key", apiSecret: "", scopes: "read_products" } });
    expect(() => resolveConfig(config)).toThrow(/apiSecret/);
  });

  it("reports every invalid field, not just the first", () => {
    const config = buildConfig({ host: "not-a-host", stateSecret: "too-short" });
    expect(() => resolveConfig(config)).toThrow(/host/);
    expect(() => resolveConfig(config)).toThrow(/stateSecret/);
  });

  it("defaults the openai challenge token to null", () => {
    expect(resolveConfig(buildConfig()).openaiAppsChallengeToken).toBeNull();
  });

  it("warns when no cache is supplied", () => {
    const warn = vi.fn();
    resolveConfig(buildConfig({ logger: { info: vi.fn(), warn, error: vi.fn() } }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("single-process"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("redisCache"));
  });

  it("does not warn when a cache is supplied", () => {
    const warn = vi.fn();
    resolveConfig(buildConfig({ logger: { info: vi.fn(), warn, error: vi.fn() }, cache: memoryCache() }));
    expect(warn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter shopify-mcp-oauth test src/config.test.ts`
Expected: FAIL — cannot resolve `./config`.

- [ ] **Step 3: Write `src/config.ts`**

```ts
import { z } from "zod";
import { memoryCache } from "./adapters/memoryCache";
import type { CacheStore, Logger, OAuthStorage } from "./types";

const DEFAULT_ACCESS_TTL_SECONDS = 3600;
const DEFAULT_REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;
const DEFAULT_REGISTER_RATE_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 };

export interface ShopifyMcpOAuthConfig {
  host: string;
  shopify: { apiKey: string; apiSecret: string; scopes: string };
  stateSecret: string;
  storage: OAuthStorage;
  cache?: CacheStore;
  tokenTtl?: { access?: number; refresh?: number };
  openaiAppsChallengeToken?: string | null;
  registerRateLimit?: { limit: number; windowMs: number };
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

export interface ResolvedConfig {
  host: string;
  resource: string;
  shopify: { apiKey: string; apiSecret: string; scopes: string };
  stateSecret: string;
  storage: OAuthStorage;
  cache: CacheStore;
  tokenTtl: { access: number; refresh: number };
  openaiAppsChallengeToken: string | null;
  registerRateLimit: { limit: number; windowMs: number };
  logger: Logger;
  fetchImpl: typeof fetch;
}

const CACHE_FALLBACK_WARNING =
  "shopify-mcp-oauth: no cache supplied, falling back to an in-memory cache. This cache is single-process, so " +
  "authorization codes and rate-limit counters written by one instance are invisible to the others and login " +
  "will fail intermittently across multiple instances — supply a shared cache such as redisCache in production.";

// A prefix regex only checks the string starts with a scheme; new URL() also catches a missing
// hostname, a query string, or a fragment, none of which are valid in the resource identifier
// this host is used to derive.
function validateHost(value: string, ctx: z.RefinementCtx): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "host must be an absolute http(s) URL" });
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "host must use the http or https protocol" });
    return;
  }
  if (!url.hostname) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "host must include a hostname" });
    return;
  }
  if (url.username || url.password) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "host must not include a username or password" });
    return;
  }
  if (url.search) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "host must not include a query string" });
    return;
  }
  if (url.hash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "host must not include a fragment" });
  }
}

const configSchema = z.object({
  host: z.string().min(1, "host is required").superRefine(validateHost),
  shopify: z.object({
    apiKey: z.string().min(1, "shopify.apiKey is required"),
    apiSecret: z.string().min(1, "shopify.apiSecret is required"),
    scopes: z.string().min(1, "shopify.scopes is required"),
  }),
  stateSecret: z.string().min(32, "stateSecret must be at least 32 characters"),
  tokenTtl: z
    .object({ access: z.number().int().positive().optional(), refresh: z.number().int().positive().optional() })
    .optional(),
  openaiAppsChallengeToken: z.string().min(1).nullish(),
  registerRateLimit: z.object({ limit: z.number().int().positive(), windowMs: z.number().int().positive() }).optional(),
});

export function resolveConfig(input: ShopifyMcpOAuthConfig): ResolvedConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `"${issue.path.join(".") || "config"}": ${issue.message}`)
      .join("; ");
    throw new Error(`shopify-mcp-oauth config invalid at ${details}`);
  }
  if (!input.storage) throw new Error('shopify-mcp-oauth config invalid at "storage": storage is required');

  // validateHost already proved this parses; re-derive from the URL (not the raw string) so the
  // scheme and hostname are lowercased and a default port is dropped — token-audience matching
  // against `resource` is plain string equality, so an unnormalized host would fail it silently.
  const parsedHost = new URL(parsed.data.host);
  const host = `${parsedHost.protocol}//${parsedHost.host}${parsedHost.pathname}`.replace(/\/+$/, "");
  const logger = input.logger ?? console;

  if (!input.cache) logger.warn(CACHE_FALLBACK_WARNING);

  return {
    host,
    resource: `${host}/mcp`,
    shopify: parsed.data.shopify,
    stateSecret: parsed.data.stateSecret,
    storage: input.storage,
    cache: input.cache ?? memoryCache(),
    tokenTtl: {
      access: parsed.data.tokenTtl?.access ?? DEFAULT_ACCESS_TTL_SECONDS,
      refresh: parsed.data.tokenTtl?.refresh ?? DEFAULT_REFRESH_TTL_SECONDS,
    },
    openaiAppsChallengeToken: parsed.data.openaiAppsChallengeToken ?? null,
    registerRateLimit: parsed.data.registerRateLimit ?? DEFAULT_REGISTER_RATE_LIMIT,
    logger,
    fetchImpl: input.fetchImpl ?? fetch,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter shopify-mcp-oauth test src/config.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shopify-mcp-oauth/src/config.ts packages/shopify-mcp-oauth/src/config.test.ts
git commit -m "feat: validate and resolve package config at construction time"
```

---

## Task 11: Request and document schemas

**Files:**
- Create: `packages/shopify-mcp-oauth/src/schemas/authorize.ts`, `token.ts`, `register.ts`, `revoke.ts`, `shopifyCallback.ts`, `cimd.ts`, `capOversizedArray.ts`
- Test: `packages/shopify-mcp-oauth/src/schemas/schemas.test.ts`

**Interfaces:**
- Consumes: `validateRedirectUri` from `../services/redirectUri`
- Produces:
  - `authorizeQuerySchema`, `type AuthorizeQuery`
  - `tokenRequestSchema`, `type AuthorizationCodeGrant`, `type RefreshTokenGrant`
  - `registerRequestSchema`, `type RegisterRequest`
  - `revokeRequestSchema`
  - `shopifyCallbackQuerySchema`
  - `cimdDocumentSchema`, `type CimdDocument`

- [ ] **Step 1: Write the failing test**

`src/schemas/schemas.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { authorizeQuerySchema } from "./authorize";
import {
  CIMD_MAX_CLIENT_NAME_LENGTH,
  CIMD_MAX_GRANT_TYPES,
  CIMD_MAX_REDIRECT_URIS,
  CIMD_MAX_RESPONSE_TYPES,
  CIMD_MAX_URI_LENGTH,
  cimdDocumentSchema,
} from "./cimd";
import {
  REGISTER_MAX_CLIENT_NAME_LENGTH,
  REGISTER_MAX_GRANT_TYPES,
  REGISTER_MAX_REDIRECT_URIS,
  REGISTER_MAX_RESPONSE_TYPES,
  REGISTER_MAX_URI_LENGTH,
  registerRequestSchema,
} from "./register";
import { revokeRequestSchema } from "./revoke";
import { shopifyCallbackQuerySchema } from "./shopifyCallback";
import { tokenRequestSchema } from "./token";

const CLIENT_ID = "https://client.example/metadata.json";
const REDIRECT_URI = "https://client.example/callback";
const DEMO_SHOP = "example.myshopify.com";
// RFC 7636 Appendix B.1 test vector (same pair used in crypto.test.ts): a real verifier/challenge
// so the length- and charset-sensitive fields below accept a genuinely conformant client.
const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function buildUriOfExactLength(length: number): string {
  const prefix = "https://client.example/";
  return (prefix + "a".repeat(length - prefix.length)).slice(0, length);
}

const validAuthorizeQuery = {
  response_type: "code",
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  state: "client-state",
  code_challenge: CODE_CHALLENGE,
  code_challenge_method: "S256",
};

describe("authorizeQuerySchema", () => {
  it("accepts a complete query", () => {
    expect(authorizeQuerySchema.safeParse(validAuthorizeQuery).success).toBe(true);
  });

  it("rejects a plain code_challenge_method", () => {
    const result = authorizeQuerySchema.safeParse({ ...validAuthorizeQuery, code_challenge_method: "plain" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing code_challenge, so PKCE cannot be skipped", () => {
    const { code_challenge, ...withoutChallenge } = validAuthorizeQuery;
    expect(authorizeQuerySchema.safeParse(withoutChallenge).success).toBe(false);
  });

  it("rejects a missing code_challenge_method, so it cannot default to plain", () => {
    const { code_challenge_method, ...withoutMethod } = validAuthorizeQuery;
    expect(authorizeQuerySchema.safeParse(withoutMethod).success).toBe(false);
  });

  it("rejects a code_challenge with an invalid length", () => {
    const result = authorizeQuerySchema.safeParse({ ...validAuthorizeQuery, code_challenge: "too-short" });
    expect(result.success).toBe(false);
  });

  it("treats resource as optional", () => {
    const parsed = authorizeQuerySchema.parse(validAuthorizeQuery);
    expect(parsed.resource).toBeUndefined();
  });
});

describe("tokenRequestSchema", () => {
  it("accepts an authorization_code grant", () => {
    const result = tokenRequestSchema.safeParse({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: CODE_VERIFIER,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a code_verifier shorter than the RFC 7636 minimum", () => {
    const result = tokenRequestSchema.safeParse({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: "too-short",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an authorization_code grant with no code_verifier", () => {
    const result = tokenRequestSchema.safeParse({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
    });
    expect(result.success).toBe(false);
  });

  it("accepts a refresh_token grant", () => {
    const result = tokenRequestSchema.safeParse({
      grant_type: "refresh_token",
      refresh_token: "the-refresh-token",
      client_id: CLIENT_ID,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown grant_type", () => {
    expect(tokenRequestSchema.safeParse({ grant_type: "password" }).success).toBe(false);
  });

  it("rejects a missing grant_type, even when every other authorization_code field is present", () => {
    const result = tokenRequestSchema.safeParse({
      code: "the-code",
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: CODE_VERIFIER,
    });
    expect(result.success).toBe(false);
  });
});

describe("registerRequestSchema", () => {
  it("accepts a minimal registration", () => {
    expect(registerRequestSchema.safeParse({ redirect_uris: [REDIRECT_URI] }).success).toBe(true);
  });

  it("rejects an empty redirect_uris array", () => {
    expect(registerRequestSchema.safeParse({ redirect_uris: [] }).success).toBe(false);
  });

  it("rejects a javascript: redirect_uri", () => {
    expect(registerRequestSchema.safeParse({ redirect_uris: ["javascript:alert(1)"] }).success).toBe(false);
  });

  it("accepts a registration at the redirect_uris cap", () => {
    const redirectUrisAtCap = Array.from(
      { length: REGISTER_MAX_REDIRECT_URIS },
      (_, index) => `https://client.example/callback/${index}`
    );
    expect(registerRequestSchema.safeParse({ redirect_uris: redirectUrisAtCap }).success).toBe(true);
  });

  it("rejects a registration exceeding the redirect_uris cap", () => {
    const redirectUrisOverCap = Array.from(
      { length: REGISTER_MAX_REDIRECT_URIS + 1 },
      (_, index) => `https://client.example/callback/${index}`
    );
    expect(registerRequestSchema.safeParse({ redirect_uris: redirectUrisOverCap }).success).toBe(false);
  });

  it("accepts a redirect_uris entry at the length cap", () => {
    const uriAtLengthCap = buildUriOfExactLength(REGISTER_MAX_URI_LENGTH);
    expect(registerRequestSchema.safeParse({ redirect_uris: [uriAtLengthCap] }).success).toBe(true);
  });

  it("rejects a redirect_uris entry exceeding the length cap", () => {
    const uriOverLengthCap = buildUriOfExactLength(REGISTER_MAX_URI_LENGTH + 1);
    expect(registerRequestSchema.safeParse({ redirect_uris: [uriOverLengthCap] }).success).toBe(false);
  });

  it("accepts a client_name at the length cap", () => {
    const clientNameAtCap = "a".repeat(REGISTER_MAX_CLIENT_NAME_LENGTH);
    expect(
      registerRequestSchema.safeParse({ redirect_uris: [REDIRECT_URI], client_name: clientNameAtCap }).success
    ).toBe(true);
  });

  it("rejects a client_name exceeding the length cap", () => {
    const clientNameOverCap = "a".repeat(REGISTER_MAX_CLIENT_NAME_LENGTH + 1);
    expect(
      registerRequestSchema.safeParse({ redirect_uris: [REDIRECT_URI], client_name: clientNameOverCap }).success
    ).toBe(false);
  });

  it("accepts grant_types at the cap", () => {
    const grantTypesAtCap = Array.from({ length: REGISTER_MAX_GRANT_TYPES }, (_, index) => `grant-${index}`);
    expect(
      registerRequestSchema.safeParse({ redirect_uris: [REDIRECT_URI], grant_types: grantTypesAtCap }).success
    ).toBe(true);
  });

  it("rejects grant_types exceeding the cap", () => {
    const grantTypesOverCap = Array.from({ length: REGISTER_MAX_GRANT_TYPES + 1 }, (_, index) => `grant-${index}`);
    expect(
      registerRequestSchema.safeParse({ redirect_uris: [REDIRECT_URI], grant_types: grantTypesOverCap }).success
    ).toBe(false);
  });

  it("accepts response_types at the cap", () => {
    const responseTypesAtCap = Array.from({ length: REGISTER_MAX_RESPONSE_TYPES }, (_, index) => `type-${index}`);
    expect(
      registerRequestSchema.safeParse({ redirect_uris: [REDIRECT_URI], response_types: responseTypesAtCap }).success
    ).toBe(true);
  });

  it("rejects response_types exceeding the cap", () => {
    const responseTypesOverCap = Array.from({ length: REGISTER_MAX_RESPONSE_TYPES + 1 }, (_, index) => `type-${index}`);
    expect(
      registerRequestSchema.safeParse({ redirect_uris: [REDIRECT_URI], response_types: responseTypesOverCap }).success
    ).toBe(false);
  });

  it("treats an absent grant_types as valid and leaves it undefined", () => {
    const result = registerRequestSchema.parse({ redirect_uris: [REDIRECT_URI] });
    expect(result.grant_types).toBeUndefined();
  });

  it("treats an absent response_types as valid and leaves it undefined", () => {
    const result = registerRequestSchema.parse({ redirect_uris: [REDIRECT_URI] });
    expect(result.response_types).toBeUndefined();
  });

  it("accepts a logo_uri at the length cap", () => {
    const logoUriAtCap = buildUriOfExactLength(REGISTER_MAX_URI_LENGTH);
    expect(registerRequestSchema.safeParse({ redirect_uris: [REDIRECT_URI], logo_uri: logoUriAtCap }).success).toBe(
      true
    );
  });

  it("rejects a logo_uri exceeding the length cap", () => {
    const logoUriOverCap = buildUriOfExactLength(REGISTER_MAX_URI_LENGTH + 1);
    expect(registerRequestSchema.safeParse({ redirect_uris: [REDIRECT_URI], logo_uri: logoUriOverCap }).success).toBe(
      false
    );
  });
});

describe("shopifyCallbackQuerySchema", () => {
  it("accepts a well-formed callback", () => {
    const result = shopifyCallbackQuerySchema.safeParse({
      shop: DEMO_SHOP,
      code: "shopify-code",
      state: "state-jwt",
      hmac: "hmac-value",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a shop domain outside myshopify.com", () => {
    const result = shopifyCallbackQuerySchema.safeParse({
      shop: "attacker.example.com",
      code: "shopify-code",
      state: "state-jwt",
      hmac: "hmac-value",
    });
    expect(result.success).toBe(false);
  });
});

describe("revokeRequestSchema", () => {
  it("accepts a minimal revoke request", () => {
    expect(revokeRequestSchema.safeParse({ token: "the-token" }).success).toBe(true);
  });

  it("rejects an unknown token_type_hint without echoing the submitted value", () => {
    const TOKEN_TYPE_HINT_VALUE = "shpat_should-not-appear-in-error";
    const result = revokeRequestSchema.safeParse({ token: "the-token", token_type_hint: TOKEN_TYPE_HINT_VALUE });

    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((issue) => issue.message).join(" ");
      expect(message).not.toContain(TOKEN_TYPE_HINT_VALUE);
      // The message alone isn't enough — zod's own enum issue carries `received` regardless of a
      // custom message, so any consumer that serializes the whole issue (logging, an API error
      // body) would still leak the value. Assert it's absent from the full serialized issue too.
      expect(JSON.stringify(result.error.issues)).not.toContain(TOKEN_TYPE_HINT_VALUE);
    }
  });

  it("preserves the narrowed token_type_hint literal type", () => {
    const result = revokeRequestSchema.parse({ token: "the-token", token_type_hint: "refresh_token" });
    // A type error here (not just a runtime one) would mean the pipe widened token_type_hint back
    // to a plain string, losing the exhaustiveness a controller relies on when comparing against it.
    const hint: "access_token" | "refresh_token" | undefined = result.token_type_hint;
    expect(hint).toBe("refresh_token");
  });
});

describe("cimdDocumentSchema", () => {
  it("accepts a document with redirect_uris", () => {
    expect(cimdDocumentSchema.safeParse({ redirect_uris: [REDIRECT_URI] }).success).toBe(true);
  });

  it("rejects a document with no redirect_uris", () => {
    expect(cimdDocumentSchema.safeParse({ client_name: "Client" }).success).toBe(false);
  });

  it("rejects a javascript: redirect_uri", () => {
    expect(cimdDocumentSchema.safeParse({ redirect_uris: ["javascript:alert(1)"] }).success).toBe(false);
  });

  it("rejects a cleartext http redirect_uri on a non-loopback host", () => {
    // The concrete exploit this closes: a CIMD document declaring an http:// redirect_uri would
    // otherwise be accepted here even though the byte-identical DCR registration is rejected by
    // registerRequestSchema's own validateRedirectUri refine, letting the authorization code be
    // delivered over cleartext HTTP.
    const result = cimdDocumentSchema.safeParse({ redirect_uris: ["http://attacker.example/cb"] });
    expect(result.success).toBe(false);
  });

  it("rejects grant_types that omit authorization_code", () => {
    const result = cimdDocumentSchema.safeParse({
      redirect_uris: [REDIRECT_URI],
      grant_types: ["client_credentials"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a token_endpoint_auth_method other than none", () => {
    const result = cimdDocumentSchema.safeParse({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "client_secret_post",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a document at the redirect_uris cap", () => {
    const redirectUrisAtCap = Array.from(
      { length: CIMD_MAX_REDIRECT_URIS },
      (_, index) => `https://client.example/callback/${index}`
    );
    expect(cimdDocumentSchema.safeParse({ redirect_uris: redirectUrisAtCap }).success).toBe(true);
  });

  it("rejects a document exceeding the redirect_uris cap", () => {
    const redirectUrisOverCap = Array.from(
      { length: CIMD_MAX_REDIRECT_URIS + 1 },
      (_, index) => `https://client.example/callback/${index}`
    );
    expect(cimdDocumentSchema.safeParse({ redirect_uris: redirectUrisOverCap }).success).toBe(false);
  });

  it("accepts a redirect_uris entry at the length cap", () => {
    const uriAtLengthCap = buildUriOfExactLength(CIMD_MAX_URI_LENGTH);
    expect(cimdDocumentSchema.safeParse({ redirect_uris: [uriAtLengthCap] }).success).toBe(true);
  });

  it("rejects a redirect_uris entry exceeding the length cap", () => {
    const uriOverLengthCap = buildUriOfExactLength(CIMD_MAX_URI_LENGTH + 1);
    expect(cimdDocumentSchema.safeParse({ redirect_uris: [uriOverLengthCap] }).success).toBe(false);
  });

  it("accepts a client_name at the length cap", () => {
    const clientNameAtCap = "a".repeat(CIMD_MAX_CLIENT_NAME_LENGTH);
    expect(cimdDocumentSchema.safeParse({ redirect_uris: [REDIRECT_URI], client_name: clientNameAtCap }).success).toBe(
      true
    );
  });

  it("rejects a client_name exceeding the length cap", () => {
    const clientNameOverCap = "a".repeat(CIMD_MAX_CLIENT_NAME_LENGTH + 1);
    expect(
      cimdDocumentSchema.safeParse({ redirect_uris: [REDIRECT_URI], client_name: clientNameOverCap }).success
    ).toBe(false);
  });

  it("accepts grant_types at the cap, including authorization_code", () => {
    const grantTypesAtCap = [
      "authorization_code",
      ...Array.from({ length: CIMD_MAX_GRANT_TYPES - 1 }, (_, index) => `grant-${index}`),
    ];
    expect(cimdDocumentSchema.safeParse({ redirect_uris: [REDIRECT_URI], grant_types: grantTypesAtCap }).success).toBe(
      true
    );
  });

  it("rejects grant_types exceeding the cap", () => {
    const grantTypesOverCap = [
      "authorization_code",
      ...Array.from({ length: CIMD_MAX_GRANT_TYPES }, (_, index) => `grant-${index}`),
    ];
    expect(
      cimdDocumentSchema.safeParse({ redirect_uris: [REDIRECT_URI], grant_types: grantTypesOverCap }).success
    ).toBe(false);
  });

  it("accepts response_types at the cap", () => {
    const responseTypesAtCap = Array.from({ length: CIMD_MAX_RESPONSE_TYPES }, (_, index) => `type-${index}`);
    expect(
      cimdDocumentSchema.safeParse({ redirect_uris: [REDIRECT_URI], response_types: responseTypesAtCap }).success
    ).toBe(true);
  });

  it("rejects response_types exceeding the cap", () => {
    const responseTypesOverCap = Array.from({ length: CIMD_MAX_RESPONSE_TYPES + 1 }, (_, index) => `type-${index}`);
    expect(
      cimdDocumentSchema.safeParse({ redirect_uris: [REDIRECT_URI], response_types: responseTypesOverCap }).success
    ).toBe(false);
  });

  it("treats an absent grant_types as valid and leaves it undefined", () => {
    const result = cimdDocumentSchema.parse({ redirect_uris: [REDIRECT_URI] });
    expect(result.grant_types).toBeUndefined();
  });

  it("treats an absent response_types as valid and leaves it undefined", () => {
    const result = cimdDocumentSchema.parse({ redirect_uris: [REDIRECT_URI] });
    expect(result.response_types).toBeUndefined();
  });

  it("reports only the count issue when grant_types is both over cap and missing authorization_code", () => {
    const grantTypesOverCapWithoutAuthCode = Array.from(
      { length: CIMD_MAX_GRANT_TYPES + 1 },
      (_, index) => `grant-${index}`
    );
    const result = cimdDocumentSchema.safeParse({
      redirect_uris: [REDIRECT_URI],
      grant_types: grantTypesOverCapWithoutAuthCode,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages).toEqual(["CIMD document has too many grant_types"]);
    }
  });

  it("accepts a logo_uri at the length cap", () => {
    const logoUriAtCap = buildUriOfExactLength(CIMD_MAX_URI_LENGTH);
    expect(cimdDocumentSchema.safeParse({ redirect_uris: [REDIRECT_URI], logo_uri: logoUriAtCap }).success).toBe(true);
  });

  it("rejects a logo_uri exceeding the length cap", () => {
    const logoUriOverCap = buildUriOfExactLength(CIMD_MAX_URI_LENGTH + 1);
    expect(cimdDocumentSchema.safeParse({ redirect_uris: [REDIRECT_URI], logo_uri: logoUriOverCap }).success).toBe(
      false
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter shopify-mcp-oauth test src/schemas`
Expected: FAIL — none of the schema modules resolve.

- [ ] **Step 3: Write the schema files**

`src/schemas/authorize.ts`:

```ts
import { z } from "zod";

// S256 is the only accepted method (see code_challenge_method below), and its output is
// deterministic: base64url(SHA-256(verifier)) with no padding is always exactly 43 characters
// from [A-Za-z0-9_-]. Unlike code_verifier's RFC 7636 charset, "." and "~" never appear here.
const S256_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const authorizeQuerySchema = z.object({
  response_type: z.literal("code", { message: "response_type must be 'code'" }),
  client_id: z.string().min(1, "client_id is required"),
  redirect_uri: z.string().min(1, "redirect_uri is required"),
  state: z.string().min(1, "state is required"),
  code_challenge: z.string().regex(S256_CHALLENGE_PATTERN, "code_challenge must be a 43-character S256 challenge"),
  code_challenge_method: z.literal("S256", { message: "code_challenge_method must be S256" }),
  // RFC 8707 says clients MUST send `resource`, but as an AS hosting a single resource we accept
  // its absence and treat it as the canonical one. When present it is exact-matched downstream.
  resource: z.string().optional(),
  scope: z.string().optional(),
});

export type AuthorizeQuery = z.infer<typeof authorizeQuerySchema>;
```

`src/schemas/token.ts`:

```ts
import { z } from "zod";

// RFC 7636 §4.1: code-verifier = 43*128unreserved, unreserved = ALPHA / DIGIT / "-" / "." / "_" / "~".
// This alphabet is wider than code_challenge's base64url charset (see authorize.ts) — verifiers are
// client-generated and the RFC permits "." and "~" here.
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

const authorizationCodeGrantSchema = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string().min(1, "code is required"),
  redirect_uri: z.string().min(1, "redirect_uri is required"),
  client_id: z.string().min(1, "client_id is required"),
  code_verifier: z
    .string()
    .regex(CODE_VERIFIER_PATTERN, "code_verifier must be 43-128 characters of unreserved RFC 7636 characters"),
});

const refreshTokenGrantSchema = z.object({
  grant_type: z.literal("refresh_token"),
  refresh_token: z.string().min(1, "refresh_token is required"),
  client_id: z.string().min(1, "client_id is required"),
  scope: z.string().optional(),
});

export const tokenRequestSchema = z.discriminatedUnion("grant_type", [
  authorizationCodeGrantSchema,
  refreshTokenGrantSchema,
]);

export type AuthorizationCodeGrant = z.infer<typeof authorizationCodeGrantSchema>;
export type RefreshTokenGrant = z.infer<typeof refreshTokenGrantSchema>;
```

`src/schemas/capOversizedArray.ts`:

Both `register.ts` and `cimd.ts` parse arrays straight off an unauthenticated boundary, so both
need this bound. Define it once — a security bound duplicated across two files drifts the moment
one of them gains a field.

```ts
// zod validates every array element's shape before any .max()/.refine() check runs, so a bounded
// count check or refine alone still pays O(n) to parse an oversized array's elements. Replace an
// over-cap array with a fixed-size placeholder before it reaches the real schema, so a hostile
// array of any size costs the same to reject as one just over the limit — a downstream .max()
// check still fires on the placeholder and reports the same message.
//
// Usage note for an optional field: wrap `.optional()` around the whole
// `z.preprocess((value) => capOversizedArray(value, cap), schema)` call, not around `schema`
// itself. `ZodOptional` short-circuits on an absent key before ever invoking the inner type, so
// that placement means this helper never runs at all when the field isn't sent — not just a
// no-op on `undefined`. `z.preprocess(fn, schema.optional())` calls `fn` with `undefined` on
// every absent field instead, which is unnecessary work even though this helper tolerates it.
//
// Internal to src/schemas/ — not part of this package's public export surface.
export function capOversizedArray(value: unknown, cap: number): unknown {
  if (Array.isArray(value) && value.length > cap) {
    return Array.from({ length: cap + 1 }, () => "");
  }
  return value;
}
```

The placeholder is `cap + 1` entries, never `cap` — an over-cap array must still fail the count
check, never be silently truncated into an accepted one.

`src/schemas/register.ts`:

Every array field gets the cap, not just `redirect_uris`. They all arrive on the same
unauthenticated request.

```ts
import { z } from "zod";
import { validateRedirectUri } from "../services/redirectUri";
import { capOversizedArray } from "./capOversizedArray";

// This body is reachable directly from an unauthenticated client's POST /register — bound its
// worst case here rather than depending on a body-size limit owned by a different layer. Limits
// are generous for any real client (a handful of redirect URIs, short display metadata) while
// still capping the cost of validating a maliciously large payload.
export const REGISTER_MAX_REDIRECT_URIS = 20;
export const REGISTER_MAX_URI_LENGTH = 2048;
export const REGISTER_MAX_GRANT_TYPES = 10;
export const REGISTER_MAX_RESPONSE_TYPES = 10;
export const REGISTER_MAX_CLIENT_NAME_LENGTH = 200;

export const registerRequestSchema = z.object({
  client_name: z.string().max(REGISTER_MAX_CLIENT_NAME_LENGTH, "client_name is too long").optional(),
  redirect_uris: z.preprocess(
    (value) => capOversizedArray(value, REGISTER_MAX_REDIRECT_URIS),
    z
      .array(z.string().max(REGISTER_MAX_URI_LENGTH, "redirect_uris entry is too long"))
      .min(1, "redirect_uris must contain at least one entry")
      .max(REGISTER_MAX_REDIRECT_URIS, "redirect_uris has too many entries")
      .refine(
        (uris) => uris.length > REGISTER_MAX_REDIRECT_URIS || uris.every((uri) => validateRedirectUri(uri) === null),
        { message: "redirect_uris contains an unacceptable URI" }
      )
  ),
  grant_types: z
    .preprocess(
      (value) => capOversizedArray(value, REGISTER_MAX_GRANT_TYPES),
      z.array(z.string()).max(REGISTER_MAX_GRANT_TYPES, "grant_types has too many entries")
    )
    .optional(),
  response_types: z
    .preprocess(
      (value) => capOversizedArray(value, REGISTER_MAX_RESPONSE_TYPES),
      z.array(z.string()).max(REGISTER_MAX_RESPONSE_TYPES, "response_types has too many entries")
    )
    .optional(),
  logo_uri: z.string().max(REGISTER_MAX_URI_LENGTH, "logo_uri is too long").optional(),
  client_uri: z.string().max(REGISTER_MAX_URI_LENGTH, "client_uri is too long").optional(),
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;
```

The `redirect_uris` refine short-circuits on `uris.length > REGISTER_MAX_REDIRECT_URIS` so an
over-cap array reports the count error alone rather than also running `validateRedirectUri` over
the placeholder entries.

`src/schemas/revoke.ts`:

Do not reach for a bare `z.enum` here. Its `invalid_enum_value` issue carries the received value
verbatim even when you override the message, so a client that misfills `token_type_hint` with a
real token gets it echoed back inside the issue object.

```ts
import { z } from "zod";

const TOKEN_TYPE_HINTS = ["access_token", "refresh_token"] as const;

function isTokenTypeHint(value: string): value is (typeof TOKEN_TYPE_HINTS)[number] {
  return (TOKEN_TYPE_HINTS as readonly string[]).includes(value);
}

// z.enum's own invalid_enum_value issue carries the received value verbatim, even with a custom
// message — the message is clean but the issue object still leaks it (e.g. via JSON.stringify(
// error.issues)). token_type_hint sits beside `token` and is the field most likely to receive a
// real token by client mistake, so validate it with a plain string + superRefine instead: a custom
// issue never carries `received`. Piping into z.enum recovers the narrowed literal type — the pipe's
// second stage never runs once the first has gone dirty, so the enum's leaky issue is unreachable.
const tokenTypeHintSchema = z
  .string()
  .superRefine((value, ctx) => {
    if (!isTokenTypeHint(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "token_type_hint must be access_token or refresh_token",
      });
    }
  })
  .pipe(z.enum(TOKEN_TYPE_HINTS));

export const revokeRequestSchema = z.object({
  token: z.string().min(1, "token is required"),
  token_type_hint: tokenTypeHintSchema.optional(),
  client_id: z.string().optional(),
});
```

The pipe is what keeps the parsed type narrowed to the two literals rather than widening to
`string`. Test that narrowing with a `@ts-expect-error`-style assertion, not just a runtime check —
a widened type is a silent regression the suite would otherwise pass straight over.

`src/schemas/shopifyCallback.ts`:

```ts
import { z } from "zod";

// Constrain the shop to Shopify's own domain so a forged `shop` cannot redirect the
// server-to-server token exchange at an attacker-controlled host.
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export const shopifyCallbackQuerySchema = z.object({
  shop: z.string().regex(SHOP_DOMAIN, "shop must be a myshopify.com domain"),
  code: z.string().min(1, "code is required"),
  state: z.string().min(1, "state is required"),
  hmac: z.string().min(1, "hmac is required"),
  host: z.string().optional(),
  timestamp: z.string().optional(),
});
```

`src/schemas/cimd.ts`:

This schema owns its own worst case. It parses a document fetched from a client-controlled URL, so
it must not assume the fetch layer's byte cap (Task 12) ran — that cap could be loosened, bypassed
by another call site, or this schema reused without it. Cap every array field, same as `register.ts`.

```ts
import { z } from "zod";
import { validateRedirectUri } from "../services/redirectUri";
import { capOversizedArray } from "./capOversizedArray";

// This document is fetched from a URL the client controls — hostile input. Bound its worst case
// here rather than depending on a fetch layer's byte cap owned by a different task: that cap could
// be loosened, bypassed by a different call site, or this schema reused without it.
export const CIMD_MAX_REDIRECT_URIS = 20;
export const CIMD_MAX_URI_LENGTH = 2048;
export const CIMD_MAX_GRANT_TYPES = 10;
export const CIMD_MAX_RESPONSE_TYPES = 10;
export const CIMD_MAX_CLIENT_NAME_LENGTH = 200;

export const cimdDocumentSchema = z.object({
  client_id: z.string().max(CIMD_MAX_URI_LENGTH, "client_id is too long").optional(),
  client_name: z.string().max(CIMD_MAX_CLIENT_NAME_LENGTH, "client_name is too long").optional(),
  // A CIMD document is fetched from a URL the client controls, exactly like a DCR request body —
  // it gets the same validateRedirectUri check register.ts applies, so a document can't declare a
  // redirect_uris entry (javascript:, cleartext http on a non-loopback host, embedded userinfo,
  // ...) that a DCR registration would be rejected for.
  redirect_uris: z.preprocess(
    (value) => capOversizedArray(value, CIMD_MAX_REDIRECT_URIS),
    z
      .array(z.string().max(CIMD_MAX_URI_LENGTH, "redirect_uris entry is too long"))
      .min(1, "CIMD document missing redirect_uris[]")
      .max(CIMD_MAX_REDIRECT_URIS, "CIMD document has too many redirect_uris")
      .refine(
        (uris) => uris.length > CIMD_MAX_REDIRECT_URIS || uris.every((uri) => validateRedirectUri(uri) === null),
        { message: "redirect_uris contains an unacceptable URI" }
      )
  ),
  // The document lists what the client supports; we only require the grant we drive.
  grant_types: z
    .preprocess(
      (value) => capOversizedArray(value, CIMD_MAX_GRANT_TYPES),
      z
        .array(z.string())
        .max(CIMD_MAX_GRANT_TYPES, "CIMD document has too many grant_types")
        .refine((types) => types.length > CIMD_MAX_GRANT_TYPES || types.includes("authorization_code"), {
          message: "CIMD grant_types must include 'authorization_code'",
        })
    )
    .optional(),
  response_types: z
    .preprocess(
      (value) => capOversizedArray(value, CIMD_MAX_RESPONSE_TYPES),
      z.array(z.string()).max(CIMD_MAX_RESPONSE_TYPES, "CIMD document has too many response_types")
    )
    .optional(),
  token_endpoint_auth_method: z
    .literal("none", { message: "CIMD token_endpoint_auth_method must be 'none'" })
    .optional(),
  logo_uri: z.string().max(CIMD_MAX_URI_LENGTH, "logo_uri is too long").optional(),
  client_uri: z.string().max(CIMD_MAX_URI_LENGTH, "client_uri is too long").optional(),
});

export type CimdDocument = z.infer<typeof cimdDocumentSchema>;
```

No `.strip()` call — stripping unknown keys is already `z.object`'s default, so writing it adds a
line that reads like it changes behaviour when it doesn't.

An over-cap `grant_types` reports the count error only, not the missing-`authorization_code` error
as well: the placeholder entries would fail the refine too, so the refine short-circuits on length
first. Lock that single-issue outcome with a test — it is a deliberate choice, not an accident.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter shopify-mcp-oauth test src/schemas`
Expected: PASS, 53 tests.

Cover every cap and both leak-shaped cases, not only the happy paths: each field's over-cap
rejection, each field's per-entry length limit, the absent-optional-field path (an optional capped
field must parse to `undefined`), the at-cap boundary (exactly `cap` entries must still be fully
validated, not shortcut), and — for `revoke.ts` — that the rejected value appears in neither the
message, the issue object, nor `JSON.stringify(error)`. Assert on the whole serialized error, not
just `issue.message`; a message-only assertion passes while the issue object leaks.

- [ ] **Step 5: Commit**

```bash
git add packages/shopify-mcp-oauth/src/schemas
git commit -m "feat: add request and CIMD document schemas"
```

---

## Task 12: Client store and CIMD resolver

**Files:**
- Create: `packages/shopify-mcp-oauth/src/services/clients.ts`
- Create: `packages/shopify-mcp-oauth/src/services/cimd.ts`
- Test: `packages/shopify-mcp-oauth/src/services/clients.test.ts`, `packages/shopify-mcp-oauth/src/services/cimd.test.ts`

**Interfaces:**
- Consumes: `ResolvedConfig` from `../config`; `cimdDocumentSchema`, `CimdDocument` from `../schemas/cimd`; `randomBase64Url` from `../crypto`; `RegisterRequest` from `../schemas/register`
- Produces:
  - `createDcrClient(config: ResolvedConfig, input: RegisterRequest): Promise<OAuthClient>`
  - `isCimdClientId(value: string): boolean`
  - `resolveCimdClient(config: ResolvedConfig, url: string, opts?: { allowPrivateHosts?: boolean }): Promise<CimdDocument>`

A client identifies itself one of two ways. **DCR** posts its metadata to `/register` and receives a
generated `client_id`. **CIMD** uses an HTTPS URL as its `client_id`, and we fetch the document that
URL serves. Resolution is three-tier: cache, then storage, then a live fetch — the fetch result is
written to both.

The live fetch is the package's only outbound request to an address the caller controls, so it is the
one place SSRF matters: HTTPS only, no private or loopback addresses, no redirects followed, a body
cap, and a hard timeout.

- [ ] **Step 1: Write the failing tests**

`src/services/clients.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig, type ResolvedConfig } from "../config";
import { createDcrClient } from "./clients";

const REDIRECT_URI = "https://client.example/callback";

function buildConfig(): ResolvedConfig {
  return resolveConfig({
    host: "https://mcp.example.com",
    shopify: { apiKey: "test-api-key", apiSecret: "test-api-secret", scopes: "read_products" },
    stateSecret: "test-state-secret-at-least-32-bytes-long",
    storage: memoryStorage(),
  });
}

describe("createDcrClient", () => {
  it("generates a client_id the caller did not supply", async () => {
    const client = await createDcrClient(buildConfig(), { redirect_uris: [REDIRECT_URI] });
    expect(client.clientId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("persists the client so it can be found again", async () => {
    const config = buildConfig();
    const created = await createDcrClient(config, { redirect_uris: [REDIRECT_URI] });
    expect(await config.storage.findClient(created.clientId)).not.toBeNull();
  });

  it("stores the supplied client_name", async () => {
    const client = await createDcrClient(buildConfig(), {
      redirect_uris: [REDIRECT_URI],
      client_name: "Registered Client",
    });
    expect(client.clientName).toBe("Registered Client");
  });

  it("forces token_endpoint_auth_method to none, since we issue only public clients", async () => {
    const client = await createDcrClient(buildConfig(), { redirect_uris: [REDIRECT_URI] });
    expect(client.tokenEndpointAuthMethod).toBe("none");
  });

  it("gives two registrations different client_ids", async () => {
    const config = buildConfig();
    const first = await createDcrClient(config, { redirect_uris: [REDIRECT_URI] });
    const second = await createDcrClient(config, { redirect_uris: [REDIRECT_URI] });
    expect(first.clientId).not.toBe(second.clientId);
  });
});
```

`src/services/cimd.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig, type ResolvedConfig } from "../config";
import type { CacheStore } from "../types";
import { isCimdClientId, resolveCimdClient } from "./cimd";

const CIMD_URL = "https://client.example/metadata.json";
const REDIRECT_URI = "https://client.example/callback";
const CIMD_DOC = { client_name: "Fetched Client", redirect_uris: [REDIRECT_URI] };

// The package's byte cap and fetch timeout on a fetched CIMD document (see cimd.ts). Duplicated
// here, not imported, because neither is part of this task's public export surface.
const CIMD_BYTE_CAP = 64 * 1024;
const CIMD_FETCH_TIMEOUT_MS = 3000;

// Silent by default so the no-cache warning does not spray stderr across every case, matching
// the convention in config.test.ts.
const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function buildConfig(
  fetchImpl: typeof fetch,
  overrides: Partial<Parameters<typeof resolveConfig>[0]> = {}
): ResolvedConfig {
  return resolveConfig({
    host: "https://mcp.example.com",
    shopify: { apiKey: "test-api-key", apiSecret: "test-api-secret", scopes: "read_products" },
    stateSecret: "test-state-secret-at-least-32-bytes-long",
    storage: memoryStorage(),
    fetchImpl,
    logger: silentLogger,
    ...overrides,
  });
}

// Builds a fresh Response per call rather than resolving the same instance every time -- a
// Response's body stream can only be read once, so a shared instance would break the moment any
// test drove two real fetches through the same fetchImpl (a confusing "body already used" error
// instead of a clear assertion failure).
function buildFetch(body: unknown, init: { status?: number } = {}): typeof fetch {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return vi.fn().mockImplementation(
    async () =>
      new Response(text, {
        status: init.status ?? 200,
        headers: { "content-type": "application/json" },
      })
  ) as unknown as typeof fetch;
}

// Builds a fetch whose Response body is a ReadableStream delivered in separate chunks and
// carries no content-length header — the shape a chunked-transfer-encoding response actually
// takes. Proves the byte cap is enforced by counting bytes as they stream in, not by reading
// (or trusting the absence of) a Content-Length header.
function buildChunkedFetch(chunks: string[]): typeof fetch {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  const response = new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
  return vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

// Like buildChunkedFetch, but enqueues one chunk per pull() call instead of all at once, and
// records every pull. Lets a test prove the reader was cancelled after the byte cap was hit —
// i.e. the stream was never drained to completion — rather than merely truncating the result
// after reading everything.
function buildLazyChunkedFetch(
  chunkText: string,
  chunkCount: number
): { fetchImpl: typeof fetch; pullCount: () => number } {
  let nextChunkIndex = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (nextChunkIndex >= chunkCount) {
        controller.close();
        return;
      }
      controller.enqueue(new TextEncoder().encode(chunkText));
      nextChunkIndex += 1;
    },
  });
  const response = new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
  return { fetchImpl, pullCount: () => nextChunkIndex };
}

// A real fetch ties the AbortSignal it's called with to the response body's stream, so aborting
// mid-download rejects a pending reader.read() -- that's how the fetch timeout is meant to reach a
// body that drips bytes without ever finishing. A mocked Response built independently of the
// signal doesn't get that behavior for free, so this fake wires it up by hand: its body stream
// never produces another chunk on its own, but rejects the pending pull() the moment the signal
// passed to fetchImpl aborts, mirroring what undici does for a real network response. Also reports
// whether it ever saw the abort, so a test can fail fast with a clear reason (instead of hanging
// for the full suite timeout) if a regression means the abort never reaches the body read.
function buildStalledBodyFetch(): { fetchImpl: typeof fetch; sawAbort: () => boolean } {
  let abortObserved = false;
  const fetchImpl = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        return new Promise<void>((_resolve, reject) => {
          const signal = init?.signal;
          const onAbort = () => {
            abortObserved = true;
            reject(new DOMException("The operation was aborted.", "AbortError"));
          };
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener("abort", onAbort);
          // Otherwise never settles -- simulates a server that stops sending bytes mid-response.
          void controller;
        });
      },
    });
    const response = new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
    return Promise.resolve(response);
  }) as unknown as typeof fetch;
  return { fetchImpl, sawAbort: () => abortObserved };
}

// Simulates a fetchImpl whose Response exposes no readable body stream at all (body: null) —
// something a nonstandard or misbehaving fetch polyfill could return. There is deliberately no
// .text() on this fake: if the implementation ever fell back to an unbounded, uncapped read
// here, this test would throw a "response.text is not a function" error instead of the expected
// one, catching that regression directly.
function buildBodylessFetch(): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    body: null,
  }) as unknown as typeof fetch;
}

// Same shape as buildBodylessFetch, but this one *does* implement .text() — spying on it so a
// test can assert it was never called. Reading the body via response.text() when there's no
// stream to cap is the exact vulnerable fallback this task was told to close off (it would
// buffer the full, unmeasured body before any size check could run). Asserting onText was never
// invoked proves that fallback path doesn't exist anymore, regardless of what it would have
// returned.
function buildBodylessFetchWithTextSpy(): { fetchImpl: typeof fetch; onText: ReturnType<typeof vi.fn> } {
  const onText = vi.fn().mockResolvedValue(JSON.stringify(CIMD_DOC));
  const fetchImpl = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    body: null,
    text: onText,
  }) as unknown as typeof fetch;
  return { fetchImpl, onText };
}

function neverHitCache(): CacheStore {
  return {
    async get() {
      return null;
    },
    async set() {},
    async del() {},
    async getdel() {
      return null;
    },
  };
}

describe("isCimdClientId", () => {
  it("is true for an https URL", () => {
    expect(isCimdClientId(CIMD_URL)).toBe(true);
  });

  it("is false for an opaque registered client_id", () => {
    expect(isCimdClientId("abc123")).toBe(false);
  });
});

describe("resolveCimdClient", () => {
  it("fetches and returns the document", async () => {
    const config = buildConfig(buildFetch(CIMD_DOC));
    const doc = await resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true });
    expect(doc.redirect_uris).toEqual([REDIRECT_URI]);
  });

  it("serves the second call from the cache without refetching, even when storage would also miss", async () => {
    // resolveCimdClient checks storage before the network too, so a naive version of this test
    // (default storage, which now holds a row after the first call) would pass even if the cache
    // were completely broken -- storage alone would prevent the second fetch. Forcing
    // storage.findClient to always miss isolates the property this test's name actually claims:
    // the cache, specifically, is what serves the second call.
    const fetchImpl = buildFetch(CIMD_DOC);
    const storage = memoryStorage();
    storage.findClient = async () => null;
    const config = buildConfig(fetchImpl, { storage });
    await resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true });
    await resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("persists the fetched client so its name survives a cache flush", async () => {
    const config = buildConfig(buildFetch(CIMD_DOC));
    await resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true });
    expect((await config.storage.findClient(CIMD_URL))?.clientName).toBe("Fetched Client");
  });

  it("rejects a non-https client_id", async () => {
    const config = buildConfig(buildFetch(CIMD_DOC));
    await expect(resolveCimdClient(config, "http://client.example/doc.json")).rejects.toThrow(/HTTPS/);
  });

  it("rejects a private-address host", async () => {
    const config = buildConfig(buildFetch(CIMD_DOC));
    await expect(resolveCimdClient(config, "https://127.0.0.1/doc.json")).rejects.toThrow(/private/);
  });

  it("rejects an IPv6 loopback literal host ([::1])", async () => {
    const config = buildConfig(buildFetch(CIMD_DOC));
    await expect(resolveCimdClient(config, "https://[::1]/doc.json")).rejects.toThrow(/private/);
  });

  it("rejects a hostname that resolves to a loopback address via DNS (localhost)", async () => {
    // Every other private-host test above uses a literal IP, which short-circuits before
    // dns.lookup() is ever called -- this is the guard's only coverage of the DNS-resolution
    // branch of assertPublicHost. Uses the real dns.lookup (no mocking): "localhost" resolves
    // locally without any network access, so this is not flaky.
    const config = buildConfig(buildFetch(CIMD_DOC));
    await expect(resolveCimdClient(config, "https://localhost/doc.json")).rejects.toThrow(/private/);
  });

  describe("SSRF guard: private, loopback, and reserved address families", () => {
    // Each row is an address family the guard must reject that a naive implementation (matching
    // on textual prefixes like "10." or "fe80:") is prone to missing -- particularly the last two,
    // which are the same private/link-local addresses smuggled through IPv6's IPv4-mapped notation
    // (the exact form WHATWG URL produces when a caller writes "[::ffff:127.0.0.1]").
    const RESERVED_ADDRESS_URLS: Array<[string, string]> = [
      ["0.0.0.0/8 (this network)", "https://0.0.0.0/doc.json"],
      ["IPv6 unspecified address (::)", "https://[::]/doc.json"],
      ["100.64.0.0/10 (carrier-grade NAT)", "https://100.64.0.1/doc.json"],
      ["fe80::/10 upper edge (link-local)", "https://[febf::1]/doc.json"],
      ["fec0::/10 (deprecated site-local)", "https://[fec0::1]/doc.json"],
      ["255.255.255.255 (broadcast, inside 240.0.0.0/4)", "https://255.255.255.255/doc.json"],
      ["224.0.0.0/4 (multicast)", "https://224.0.0.1/doc.json"],
      ["ff00::/8 (IPv6 multicast)", "https://[ff02::1]/doc.json"],
      ["240.0.0.0/4 (reserved)", "https://240.0.0.1/doc.json"],
      ["192.0.0.0/24 (IETF protocol assignments)", "https://192.0.0.1/doc.json"],
      ["198.18.0.0/15 (benchmarking)", "https://198.18.0.1/doc.json"],
      ["IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)", "https://[::ffff:127.0.0.1]/doc.json"],
      ["IPv4-mapped IPv6 cloud-metadata address (::ffff:169.254.169.254)", "https://[::ffff:169.254.169.254]/doc.json"],
      ["NAT64-embedded cloud-metadata address (64:ff9b::a9fe:a9fe)", "https://[64:ff9b::a9fe:a9fe]/doc.json"],
      ["6to4-embedded loopback address (2002:7f00:1::)", "https://[2002:7f00:1::]/doc.json"],
    ];

    it.each(RESERVED_ADDRESS_URLS)("rejects %s", async (_description, url) => {
      const config = buildConfig(buildFetch(CIMD_DOC));
      await expect(resolveCimdClient(config, url)).rejects.toThrow(/private/);
    });

    // A blanket rule wide enough to catch every reserved family can just as easily be wide
    // enough to swallow legitimate public hosts too -- these are the regression guard for that.
    // (This is not a hypothetical: an earlier draft added a single net.BlockList subnet meant to
    // catch IPv4-mapped IPv6 literals and it silently rejected every public IPv4 host, this test
    // included, because of how net.BlockList normalizes an "ipv4" check against that subnet.)
    const PUBLIC_ADDRESS_URLS: Array<[string, string]> = [
      ["a public IPv4 host", "https://8.8.8.8/doc.json"],
      ["a public IPv6 host", "https://[2001:db8::1]/doc.json"],
      ["a public host in IPv4-mapped IPv6 notation", "https://[::ffff:8.8.8.8]/doc.json"],
      // These two are the direct regression guard against over-broad NAT64/6to4 exclusion: a
      // blanket rule over the whole 64:ff9b::/96 or 2002::/16 prefix would reject these, since
      // 8.8.8.8's embedded form is just as much "inside" that prefix as 169.254.169.254's is.
      // Extracting the embedded address and reclassifying it is what tells them apart.
      ["a public host in NAT64 notation (64:ff9b::808:808 = 8.8.8.8)", "https://[64:ff9b::808:808]/doc.json"],
      ["a public host in 6to4 notation (2002:808:808:: = 8.8.8.8)", "https://[2002:808:808::]/doc.json"],
    ];

    it.each(PUBLIC_ADDRESS_URLS)("does not reject %s", async (_description, url) => {
      const config = buildConfig(buildFetch(CIMD_DOC));
      const doc = await resolveCimdClient(config, url);
      expect(doc.redirect_uris).toEqual([REDIRECT_URI]);
    });
  });

  it("rejects a non-200 response", async () => {
    const config = buildConfig(buildFetch("nope", { status: 404 }));
    await expect(resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true })).rejects.toThrow(/404/);
  });

  it("rejects a body that is not JSON", async () => {
    const config = buildConfig(buildFetch("<html>not json</html>"));
    await expect(resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true })).rejects.toThrow(/JSON/);
  });

  it("rejects a document with no redirect_uris", async () => {
    const config = buildConfig(buildFetch({ client_name: "No Redirects" }));
    await expect(resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true })).rejects.toThrow(/redirect_uris/);
  });

  it("rejects a document whose redirect_uris contains a cleartext http URI on a non-loopback host", async () => {
    // End-to-end proof that cimdDocumentSchema's validateRedirectUri refine actually reaches this
    // call site: a byte-identical DCR registration would be rejected by registerRequestSchema for
    // the same URI, so a CIMD document must not be able to smuggle it through unvalidated.
    const config = buildConfig(
      buildFetch({ client_name: "Bad Redirect", redirect_uris: ["http://attacker.example/cb"] })
    );
    await expect(resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true })).rejects.toThrow(/redirect_uris/);
  });

  it("does not follow redirects", async () => {
    const fetchImpl = buildFetch(CIMD_DOC);
    const config = buildConfig(fetchImpl);
    await resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true });
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  describe("byte cap enforcement", () => {
    it("accepts a body exactly at the byte cap (rejected only by JSON.parse, proving the cap boundary is inclusive)", async () => {
      const bodyAtCap = "x".repeat(CIMD_BYTE_CAP);
      const config = buildConfig(buildFetch(bodyAtCap));
      // Not valid JSON, so a body that cleared the byte cap still fails downstream — this
      // isolates exactly where the boundary sits, independent of JSON well-formedness.
      await expect(resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true })).rejects.toThrow(/JSON/);
    });

    it("rejects a body one byte over the cap", async () => {
      const bodyOverCap = "x".repeat(CIMD_BYTE_CAP + 1);
      const config = buildConfig(buildFetch(bodyOverCap));
      await expect(resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true })).rejects.toThrow(/exceeds/);
    });

    it("a stream-bodied Response carries no content-length header (sanity check for the tests below)", () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x"));
          controller.close();
        },
      });
      const response = new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
      expect(response.headers.get("content-length")).toBeNull();
    });

    it("rejects an oversized body delivered as multiple chunks with no content-length header", async () => {
      const fortyKilobyteChunk = "x".repeat(40 * 1024);
      const fetchImpl = buildChunkedFetch([fortyKilobyteChunk, fortyKilobyteChunk]); // 80KB total, cap is 64KB
      const config = buildConfig(fetchImpl);

      await expect(resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true })).rejects.toThrow(/exceeds/);
    });

    it("rejects an oversized non-JSON body with the size error, not a JSON-parse error — proving the cap is checked before JSON.parse runs", async () => {
      const fortyKilobyteChunk = "not valid json ".repeat(40 * 1024 - 1).slice(0, 40 * 1024);
      const fetchImpl = buildChunkedFetch([fortyKilobyteChunk, fortyKilobyteChunk]);
      const config = buildConfig(fetchImpl);
      const error = await resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true }).catch(
        (caught: unknown) => caught
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/exceeds/);
      expect((error as Error).message).not.toMatch(/JSON/);
    });

    it("cancels the stream once the cap is exceeded instead of draining it to completion", async () => {
      const twentyKilobyteChunk = "x".repeat(20 * 1024);
      // 10 chunks are available (200KB total). The running total crosses the 64KB cap after the
      // 4th chunk (81920 bytes); the stream's own internal read-ahead can have already requested
      // one more chunk by the time reader.cancel() takes effect, so 4-5 pulls is the deterministic
      // "stopped early" range. What this test guards against is draining all 10 (200KB) — if the
      // cap weren't enforced by streaming, every chunk would be pulled before any rejection.
      const { fetchImpl, pullCount } = buildLazyChunkedFetch(twentyKilobyteChunk, 10);
      const config = buildConfig(fetchImpl);
      await expect(resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true })).rejects.toThrow(/exceeds/);
      expect(pullCount()).toBeGreaterThanOrEqual(4);
      expect(pullCount()).toBeLessThanOrEqual(5);
    });

    it("fails closed when the fetch response exposes no readable body stream", async () => {
      const config = buildConfig(buildBodylessFetch());
      await expect(resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true })).rejects.toThrow(/readable body/);
    });

    it("never falls back to an unbounded response.text() read when there is no body stream", async () => {
      const { fetchImpl, onText } = buildBodylessFetchWithTextSpy();
      const config = buildConfig(fetchImpl);
      await expect(resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true })).rejects.toThrow(/readable body/);
      expect(onText).not.toHaveBeenCalled();
    });
  });

  describe("fetch timeout", () => {
    // afterEach (not an in-test try/finally) restores real timers even if the test below times
    // out instead of failing a normal assertion -- vitest abandons the test body on timeout, so a
    // finally block inside it would never run, leaking fake timers into later tests.
    afterEach(() => {
      vi.useRealTimers();
    });

    it("rejects a body that stalls mid-stream within the timeout, instead of hanging until the byte cap is reached", async () => {
      // Headers arrive immediately (the mocked Response resolves right away); the body then never
      // produces another byte on its own, staying well under the 64KB cap forever. Only the
      // timeout can end this -- proves the AbortController fires during the body read, not just
      // during the initial fetchImpl call.
      vi.useFakeTimers();
      const { fetchImpl, sawAbort } = buildStalledBodyFetch();
      const config = buildConfig(fetchImpl);
      const resolution = resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true });
      // Attach the rejection handler before advancing timers, not after -- resolution can reject
      // as soon as the timer fires, and attaching .rejects afterward leaves a window where it
      // rejects with nothing listening yet (an unhandled-rejection warning, even though the test
      // still passes overall).
      const assertion = expect(resolution).rejects.toThrow(/abort/i);
      await vi.advanceTimersByTimeAsync(CIMD_FETCH_TIMEOUT_MS + 1);
      // Fails fast with a clear reason if the abort never reached the body read -- without this,
      // a regression here previously hung for the full suite timeout with no diagnostic.
      expect(sawAbort()).toBe(true);
      await assertion;
    });
  });

  // Documents (and pins) the consequence of OAuthStorage.upsertClient being insert-if-absent:
  // once a CIMD client's document has been fetched and stored once, resolveCimdClient never
  // fetches that URL live again on its own — a cache miss falls back to the storage row, not to
  // the network, forever. A legitimate redirect_uris rotation at the live URL is invisible until
  // the stored row is deleted out-of-band. This is deliberate per the brief and per upsertClient's
  // documented contract; not something this task changes.
  it("keeps serving the originally stored document forever, even after the live document changes and the cache is bypassed", async () => {
    const originalRedirectUri = "https://client.example/original-callback";
    const rotatedRedirectUri = "https://client.example/rotated-callback";
    const originalDoc = { client_name: "Rotating Client", redirect_uris: [originalRedirectUri] };
    const rotatedDoc = { client_name: "Rotating Client", redirect_uris: [rotatedRedirectUri] };

    const config = buildConfig(buildFetch(originalDoc), { cache: neverHitCache() });
    const firstResolution = await resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true });
    expect(firstResolution.redirect_uris).toEqual([originalRedirectUri]);

    const rotatedFetchImpl = buildFetch(rotatedDoc);
    config.fetchImpl = rotatedFetchImpl;
    const secondResolution = await resolveCimdClient(config, CIMD_URL, { allowPrivateHosts: true });

    expect(secondResolution.redirect_uris).toEqual([originalRedirectUri]);
    expect(rotatedFetchImpl).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter shopify-mcp-oauth test src/services/clients.test.ts src/services/cimd.test.ts`
Expected: FAIL — cannot resolve `./clients` and `./cimd`.

- [ ] **Step 3: Write `src/services/clients.ts`**

```ts
import type { ResolvedConfig } from "../config";
import { randomBase64Url } from "../crypto";
import type { CimdDocument } from "../schemas/cimd";
import type { RegisterRequest } from "../schemas/register";
import type { OAuthClient } from "../types";

export async function createDcrClient(config: ResolvedConfig, input: RegisterRequest): Promise<OAuthClient> {
  return config.storage.createClient({
    clientId: randomBase64Url(32),
    clientName: input.client_name ?? null,
    redirectUris: input.redirect_uris,
    grantTypes: input.grant_types ?? null,
    responseTypes: input.response_types ?? null,
    logoUri: input.logo_uri ?? null,
    clientUri: input.client_uri ?? null,
    // We never issue client secrets, so the client authenticates with PKCE alone.
    tokenEndpointAuthMethod: "none",
  });
}

export async function upsertCimdClient(
  config: ResolvedConfig,
  clientIdUrl: string,
  doc: CimdDocument
): Promise<OAuthClient> {
  return config.storage.upsertClient({
    clientId: clientIdUrl,
    clientName: doc.client_name ?? null,
    redirectUris: doc.redirect_uris,
    grantTypes: doc.grant_types ?? null,
    responseTypes: doc.response_types ?? null,
    logoUri: doc.logo_uri ?? null,
    clientUri: doc.client_uri ?? null,
    tokenEndpointAuthMethod: "none",
  });
}

export function clientToCimdDocument(client: OAuthClient): CimdDocument {
  return {
    client_name: client.clientName ?? undefined,
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes ?? undefined,
    response_types: client.responseTypes ?? undefined,
    logo_uri: client.logoUri ?? undefined,
    client_uri: client.clientUri ?? undefined,
    token_endpoint_auth_method: "none",
  };
}
```

- [ ] **Step 4: Write `src/services/cimd.ts`**

```ts
import dns from "node:dns/promises";
import net from "node:net";
import type { ResolvedConfig } from "../config";
import { OAuthError } from "../errors";
import { cimdDocumentSchema, type CimdDocument } from "../schemas/cimd";
import type { Logger } from "../types";
import { clientToCimdDocument, upsertCimdClient } from "./clients";

const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 3000;
const CACHE_TTL_SECONDS = 3600;
const CACHE_PREFIX = "mcp:oauth:cimd:";

export function isCimdClientId(value: string): boolean {
  return value.startsWith("https://");
}

interface PrivateAddressRange {
  type: net.IPVersion;
  subnet: string;
  prefix: number;
}

// Every family the SSRF guard must reject, expressed as CIDR ranges rather than string-prefix
// matching on address text. net.BlockList classifies by the address's actual numeric value, so a
// v4-mapped IPv6 literal (e.g. "::ffff:7f00:1" -- the hex-hextet form WHATWG URL produces for
// "[::ffff:127.0.0.1]") is caught by its 128-bit value, not by which textual notation it happens
// to be written in.
//
// No separate "IPv4-mapped" entry is listed here (verified, not assumed): net.BlockList already
// normalizes an "ipv4"-typed rule to also match its IPv4-mapped IPv6 form automatically (a bare
// "127.0.0.0/8, ipv4" rule alone blocks check("::ffff:127.0.0.1", "ipv6")), so every ipv4 range
// below already covers its own mapped form for free. Adding an explicit "::ffff:0:0/96, ipv6"
// rule on top of that was tried and measured to be actively harmful, not merely redundant: because
// net.BlockList normalizes a plain IPv4 check the same way in reverse, that single subnet made
// check(anyIPv4, "ipv4") return true unconditionally -- it silently rejected every public IPv4
// host, including 8.8.8.8. Caught by the "does not reject a public IPv4/IPv6 host" tests below,
// which is exactly what they exist to guard against.
//
// The deprecated IPv4-compatible notation ("::a.b.c.d", distinct from IPv4-mapped) is deliberately
// not covered. A single blanket "::/96" rule can't discriminate an embedded public address from an
// embedded private one (verified: check("::808:808" [8.8.8.8's compatible form], "ipv6") is also
// true) -- the private ranges could instead be enumerated individually as explicit ipv6 rules in
// this notation, the same way the ipv4 ranges are, but that notation has been obsolete since RFC
// 4291 (2006), is never produced by dns.lookup or by WHATWG URL's own IPv6 serialization, and
// offers an attacker nothing that IPv4-mapped notation doesn't already give them -- not worth the
// extra entries for a notation nothing in this guard's real inputs ever produces.
const PRIVATE_ADDRESS_RANGES: PrivateAddressRange[] = [
  { type: "ipv4", subnet: "0.0.0.0", prefix: 8 }, // "this network"
  { type: "ipv4", subnet: "10.0.0.0", prefix: 8 }, // RFC 1918 private
  { type: "ipv4", subnet: "100.64.0.0", prefix: 10 }, // RFC 6598 carrier-grade NAT
  { type: "ipv4", subnet: "127.0.0.0", prefix: 8 }, // loopback
  { type: "ipv4", subnet: "169.254.0.0", prefix: 16 }, // link-local, incl. cloud metadata hosts
  { type: "ipv4", subnet: "172.16.0.0", prefix: 12 }, // RFC 1918 private
  { type: "ipv4", subnet: "192.0.0.0", prefix: 24 }, // IETF protocol assignments
  { type: "ipv4", subnet: "192.168.0.0", prefix: 16 }, // RFC 1918 private
  { type: "ipv4", subnet: "198.18.0.0", prefix: 15 }, // benchmarking (RFC 2544)
  { type: "ipv4", subnet: "224.0.0.0", prefix: 4 }, // multicast
  { type: "ipv4", subnet: "240.0.0.0", prefix: 4 }, // reserved, incl. 255.255.255.255 broadcast
  { type: "ipv6", subnet: "::1", prefix: 128 }, // loopback
  { type: "ipv6", subnet: "::", prefix: 128 }, // unspecified
  { type: "ipv6", subnet: "fe80::", prefix: 10 }, // link-local
  { type: "ipv6", subnet: "fec0::", prefix: 10 }, // deprecated site-local
  { type: "ipv6", subnet: "fc00::", prefix: 7 }, // unique local (covers both fc00::/8 and fd00::/8)
  { type: "ipv6", subnet: "ff00::", prefix: 8 }, // multicast, for symmetry with 224.0.0.0/4 above
];

function buildPrivateAddressBlockList(): net.BlockList {
  const blockList = new net.BlockList();
  for (const range of PRIVATE_ADDRESS_RANGES) {
    blockList.addSubnet(range.subnet, range.prefix, range.type);
  }
  return blockList;
}

const privateAddressBlockList = buildPrivateAddressBlockList();

// Expands any valid IPv6 literal (net.isIPv6 must already be true) to its 8 constituent 16-bit
// groups, handling "::" compression and an embedded IPv4 dotted-quad tail (e.g. "::ffff:1.2.3.4").
// Used only to pull specific groups out at fixed offsets for NAT64/6to4 detection below -- this is
// not a general-purpose formatter.
function expandIpv6Groups(addr: string): number[] | null {
  const lastColonIndex = addr.lastIndexOf(":");
  const tail = addr.slice(lastColonIndex + 1);
  const normalized = net.isIPv4(tail) ? `${addr.slice(0, lastColonIndex + 1)}${ipv4ToHexGroups(tail).join(":")}` : addr;

  let groups: string[];
  if (normalized.includes("::")) {
    const [head = "", tailPart = ""] = normalized.split("::");
    const headGroups = head ? head.split(":").filter((group) => group.length > 0) : [];
    const tailGroups = tailPart ? tailPart.split(":").filter((group) => group.length > 0) : [];
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0) return null;
    groups = [...headGroups, ...Array(missing).fill("0"), ...tailGroups];
  } else {
    groups = normalized.split(":");
  }
  if (groups.length !== 8) return null;

  const result: number[] = [];
  for (const group of groups) {
    const value = parseInt(group === "" ? "0" : group, 16);
    if (Number.isNaN(value) || value < 0 || value > 0xffff) return null;
    result.push(value);
  }
  return result;
}

function ipv4ToHexGroups(ipv4: string): [string, string] {
  const octets = ipv4.split(".").map(Number);
  const hi = (((octets[0] ?? 0) << 8) | (octets[1] ?? 0)) >>> 0;
  const lo = (((octets[2] ?? 0) << 8) | (octets[3] ?? 0)) >>> 0;
  return [hi.toString(16), lo.toString(16)];
}

function groupsToIpv4(high: number, low: number): string {
  return [(high >>> 8) & 0xff, high & 0xff, (low >>> 8) & 0xff, low & 0xff].join(".");
}

// NAT64 (RFC 6052, "64:ff9b::/96") and 6to4 (RFC 3056, "2002::/16") both carry a plain IPv4 address
// at a fixed bit offset rather than being private ranges in their own right. A blanket BlockList
// rule over either whole prefix can't tell an embedded private address from an embedded public one
// (verified: it blocks 8.8.8.8's NAT64/6to4 forms exactly as readily as 169.254.169.254's -- the
// same "::/96 can't discriminate" problem already documented above for IPv4-compatible notation,
// just relocated to these prefixes). So instead of adding table rows for these notations, extract
// the embedded IPv4 and reclassify *that* through the one set of ipv4 rules already above --
// there's nothing to keep in sync if a twelfth ipv4 range is ever added, because there's no second
// list of ranges written in these notations to forget to update.
//
// Teredo ("2001::/32") is deliberately not handled the same way: its embedded bits are the
// tunneling client's own obfuscated public address/port for a specific peer-to-peer session, not
// an arbitrary routable target the way NAT64/6to4 embed one -- there's no "the real destination" to
// extract. It's also disabled by default on effectively every current platform, so it doesn't carry
// NAT64's "real, deployed gateway" justification for accepting any residual risk here.
function extractEmbeddedIpv4(addr: string): string | null {
  const groups = expandIpv6Groups(addr);
  if (!groups) return null;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return groupsToIpv4(g6 ?? 0, g7 ?? 0);
  }
  if (g0 === 0x2002) {
    return groupsToIpv4(g1 ?? 0, g2 ?? 0);
  }
  return null;
}

function isPrivateOrLoopbackIp(addr: string): boolean {
  if (net.isIPv4(addr)) return privateAddressBlockList.check(addr, "ipv4");
  if (net.isIPv6(addr)) {
    const embeddedIpv4 = extractEmbeddedIpv4(addr);
    if (embeddedIpv4) return privateAddressBlockList.check(embeddedIpv4, "ipv4");
    return privateAddressBlockList.check(addr, "ipv6");
  }
  // Not a recognizable IP literal at all. Unreachable via this file's current call sites (both
  // only ever pass a value net.isIP has already validated) -- kept as defense in depth rather than
  // silently treating an unrecognized value as public.
  return true;
}

// URL.hostname keeps the brackets on an IPv6 literal (e.g. "[::1]"), but net.isIP/isIPv6 only
// recognize the bare address — strip them before classifying, or every IPv6 literal silently
// falls through to dns.lookup(), which fails the whole request with a generic ENOTFOUND instead
// of the intended private-address rejection.
function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return hostname.slice(1, -1);
  return hostname;
}

async function assertPublicHost(url: URL, logger: Logger): Promise<void> {
  const host = url.hostname;
  const literal = stripIpv6Brackets(host);
  if (net.isIP(literal)) {
    if (isPrivateOrLoopbackIp(literal)) {
      // The caller supplied this IP literally, so naming it back is not a disclosure of anything
      // they don't already know.
      throw new OAuthError("invalid_client", `CIMD URL host ${literal} resolves to a private/loopback address`);
    }
    return;
  }
  try {
    const addresses = await dns.lookup(host, { all: true });
    for (const address of addresses) {
      if (isPrivateOrLoopbackIp(address.address)) {
        // Unlike the literal-IP branch above, this address came from *our* resolver, not from the
        // caller — split-horizon DNS means it can differ from what the caller's own resolver would
        // return, so it's internal information and must not ride in the client-facing description.
        // The full detail (including the resolved address) still goes to the log, for our own
        // debugging.
        logger.warn(
          `cimd: rejected CIMD URL host ${host}, which resolved to private/loopback address ${address.address}`
        );
        throw new OAuthError("invalid_client", `CIMD URL host ${host} resolves to a private/loopback address`);
      }
    }
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError("invalid_client", `CIMD URL host ${host} could not be resolved`);
  }
}

// Reads the response body through its stream, counting real bytes as they arrive and aborting
// as soon as the running total exceeds MAX_BYTES — this never consults Content-Length, so a
// chunked-transfer-encoding response that omits it entirely is capped exactly the same way. A
// response with no stream to read is refused outright rather than falling back to an unbounded
// response.text() read, which would defeat the cap for any fetchImpl that doesn't expose one.
async function readBodyCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new OAuthError("invalid_client", "CIMD fetch response has no readable body");
  }
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new OAuthError("invalid_client", `CIMD document exceeds ${MAX_BYTES} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    // The timeout's AbortController is wired to this same read (see fetchCimd) -- a body that
    // stalls past TIMEOUT_MS rejects here, not at the initial fetchImpl call. Fixed text, not the
    // caught error's message, either way: a raw stream error could carry connection-level detail.
    if (error instanceof Error && error.name === "AbortError") {
      throw new OAuthError("invalid_client", "CIMD document fetch was aborted (timed out)");
    }
    throw new OAuthError("invalid_client", "CIMD document could not be read");
  }
  return text + decoder.decode();
}

async function fetchCimd(config: ResolvedConfig, urlStr: string, allowPrivateHosts: boolean): Promise<CimdDocument> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new OAuthError("invalid_client", "CIMD client_id must be a valid URL");
  }
  if (url.protocol !== "https:") throw new OAuthError("invalid_client", "CIMD client_id must use HTTPS");
  if (!allowPrivateHosts) await assertPublicHost(url, config.logger);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let text: string;
  try {
    // The timer must stay live through the body read, not just the initial fetch -- a server
    // that responds with headers immediately but drips the body slowly (staying under the byte
    // cap the whole time) would otherwise pin a handler and a socket indefinitely.
    let response: Response;
    try {
      response = await config.fetchImpl(urlStr, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
        redirect: "error",
      });
    } catch (error) {
      // Fixed text, not the caught error's message: a raw network error (e.g. a connection-refused
      // message naming an address) is server-side detail about how *we* tried to reach the
      // client's host, not a judgment about the client's document — but classifying it as
      // OAuthError here is still correct, because from an unauthenticated caller's point of view
      // "we couldn't fetch your document" is exactly as safe to say as any of the throws below.
      if (error instanceof Error && error.name === "AbortError") {
        throw new OAuthError("invalid_client", "CIMD document fetch was aborted (timed out)");
      }
      throw new OAuthError("invalid_client", "CIMD document could not be fetched");
    }
    if (!response.ok) throw new OAuthError("invalid_client", `CIMD fetch returned ${response.status}`);
    // The byte cap is enforced here, before JSON.parse ever runs — an oversized body never
    // reaches the parser, let alone the schema, regardless of whether it would have been valid
    // JSON.
    text = await readBodyCapped(response);
  } finally {
    clearTimeout(timer);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new OAuthError("invalid_client", "CIMD document is not valid JSON");
  }
  const parsed = cimdDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (!issue) throw new OAuthError("invalid_client", "CIMD document is invalid");
    // zod's own message for a missing required field is the generic "Required", with no mention
    // of which field — prefix the field path so callers (and this file's own tests) can tell
    // which part of the document failed without inspecting the ZodError directly.
    const message = issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
    throw new OAuthError("invalid_client", message);
  }
  return parsed.data;
}

export async function resolveCimdClient(
  config: ResolvedConfig,
  url: string,
  opts: { allowPrivateHosts?: boolean } = {}
): Promise<CimdDocument> {
  if (!isCimdClientId(url)) throw new OAuthError("invalid_client", "CIMD client_id must use HTTPS");

  const cacheKey = `${CACHE_PREFIX}${url}`;
  try {
    const cached = await config.cache.get(cacheKey);
    if (cached) return JSON.parse(cached) as CimdDocument;
  } catch {
    // A cache outage must not break login; fall through to storage and the network.
  }

  // Left unguarded deliberately: a storage failure here is an infrastructure error, not a
  // statement about the client's own CIMD document, and must propagate as an ordinary Error so
  // it reaches the caller's generic-failure path instead of being classified as OAuthError
  // ("this client_id is invalid") — see the throws above and below, which are all judgments about
  // the client's own URL/document and are safe to name to an unauthenticated caller.
  const stored = await config.storage.findClient(url);
  if (stored) {
    const doc = clientToCimdDocument(stored);
    await config.cache.set(cacheKey, JSON.stringify(doc), CACHE_TTL_SECONDS).catch(() => {});
    return doc;
  }

  const doc = await fetchCimd(config, url, opts.allowPrivateHosts ?? false);

  try {
    await upsertCimdClient(config, url, doc);
  } catch (error) {
    config.logger.error("cimd: failed to persist client", error);
  }
  await config.cache.set(cacheKey, JSON.stringify(doc), CACHE_TTL_SECONDS).catch(() => {});
  return doc;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter shopify-mcp-oauth test src/services/clients.test.ts src/services/cimd.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/shopify-mcp-oauth/src/services/clients.ts packages/shopify-mcp-oauth/src/services/clients.test.ts packages/shopify-mcp-oauth/src/services/cimd.ts packages/shopify-mcp-oauth/src/services/cimd.test.ts
git commit -m "feat: add DCR client creation and the SSRF-guarded CIMD resolver"
```

---

## Task 13: Authorization codes and tokens

**Files:**
- Create: `packages/shopify-mcp-oauth/src/services/codes.ts`
- Create: `packages/shopify-mcp-oauth/src/services/tokens.ts`
- Test: `packages/shopify-mcp-oauth/src/services/codes.test.ts`, `packages/shopify-mcp-oauth/src/services/tokens.test.ts`

**Interfaces:**
- Consumes: `ResolvedConfig`; `randomBase64Url`, `sha256Hex` from `../crypto`
- Produces:
  - `interface CodeRecord { shopId: string | number; shopDomain: string; clientId: string; redirectUri: string; codeChallenge: string; codeChallengeMethod: string; resource: string }`
  - `issueCode(config: ResolvedConfig, input: CodeRecord & { ttlSeconds?: number }): Promise<{ code: string }>`
  - `consumeCode(config: ResolvedConfig, code: string): Promise<CodeRecord | null>`
  - `interface IssuedTokens { access_token: string; refresh_token: string; expires_in: number; scope: string; token_type: "Bearer" }`
  - `issueTokens(config: ResolvedConfig, input: { shopId: string | number; shopDomain: string; clientId: string; scope?: string; resource?: string; rotatedFromId?: string | null }): Promise<IssuedTokens>`
  - `rotateRefresh(config: ResolvedConfig, refreshToken: string, clientId: string): Promise<IssuedTokens | null>`
  - `revokeByAccessToken(config: ResolvedConfig, token: string): Promise<void>`
  - `revokeByRefreshToken(config: ResolvedConfig, token: string): Promise<void>`

Codes live in the cache with a 60-second TTL and are keyed by their own hash, so a cache dump does not
yield redeemable codes. Redemption goes through `getdel` where the backend supports it, which is what
makes a code single-use under concurrent `/token` calls.

Refresh rotation is one-time-use by construction: it revokes the presented token first and only mints
a new pair if that revocation actually flipped the row, so two concurrent refreshes cannot both win.

- [ ] **Step 1: Write the failing tests**

`src/services/codes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig, type ResolvedConfig } from "../config";
import { sha256Hex } from "../crypto";
import { consumeCode, issueCode, type CodeRecord } from "./codes";

const DEMO_SHOP = "example.myshopify.com";
const DEMO_SHOP_ID = "shop_1";
const CLIENT_ID = "test-client-id";
const REDIRECT_URI = "https://client.example/callback";
const RESOURCE = "https://mcp.example.com/mcp";

function buildConfig(): ResolvedConfig {
  return resolveConfig({
    host: "https://mcp.example.com",
    shopify: { apiKey: "test-api-key", apiSecret: "test-api-secret", scopes: "read_products" },
    stateSecret: "test-state-secret-at-least-32-bytes-long",
    storage: memoryStorage(),
  });
}

function buildCodeRecord(overrides: Partial<CodeRecord> = {}): CodeRecord {
  return {
    shopId: DEMO_SHOP_ID,
    shopDomain: DEMO_SHOP,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    codeChallenge: "challenge-value",
    codeChallengeMethod: "S256",
    resource: RESOURCE,
    ...overrides,
  };
}

describe("authorization codes", () => {
  it("round-trips the record", async () => {
    const config = buildConfig();
    const record = buildCodeRecord();
    const { code } = await issueCode(config, record);
    expect(await consumeCode(config, code)).toEqual(record);
  });

  it("cannot be consumed twice", async () => {
    const config = buildConfig();
    const { code } = await issueCode(config, buildCodeRecord());
    await consumeCode(config, code);
    expect(await consumeCode(config, code)).toBeNull();
  });

  it("returns null for a code that was never issued", async () => {
    expect(await consumeCode(buildConfig(), "never-issued")).toBeNull();
  });

  it("does not store a code whose ttl has already passed", async () => {
    const config = buildConfig();
    const { code } = await issueCode(config, { ...buildCodeRecord(), ttlSeconds: -1 });
    expect(await consumeCode(config, code)).toBeNull();
  });

  it("stores the code under its hash, not its plaintext", async () => {
    const config = buildConfig();
    const { code } = await issueCode(config, buildCodeRecord());
    expect(await config.cache.get(`mcp:oauth:code:${code}`)).toBeNull();
    expect(await config.cache.get(`mcp:oauth:code:${sha256Hex(code)}`)).not.toBeNull();
  });

  it("returns null instead of throwing for a corrupted cache entry", async () => {
    const config = buildConfig();
    const code = "hand-crafted-code";
    await config.cache.set(`mcp:oauth:code:${sha256Hex(code)}`, "{not valid json", 60);
    await expect(consumeCode(config, code)).resolves.toBeNull();
  });
});
```

`src/services/tokens.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig, type ResolvedConfig } from "../config";
import { sha256Hex } from "../crypto";
import { issueTokens, revokeByAccessToken, revokeByRefreshToken, rotateRefresh } from "./tokens";

const DEMO_SHOP = "example.myshopify.com";
const DEMO_SHOP_ID = "shop_1";
const CLIENT_ID = "test-client-id";
const CUSTOM_SCOPE = "mcp:custom-scope";
const CUSTOM_RESOURCE = "https://mcp.example.com/custom-resource";

function buildConfig(overrides: { tokenTtl?: { access?: number; refresh?: number } } = {}): ResolvedConfig {
  return resolveConfig({
    host: "https://mcp.example.com",
    shopify: { apiKey: "test-api-key", apiSecret: "test-api-secret", scopes: "read_products" },
    stateSecret: "test-state-secret-at-least-32-bytes-long",
    storage: memoryStorage(),
    ...overrides,
  });
}

describe("issueTokens", () => {
  it("returns a Bearer bundle", async () => {
    const tokens = await issueTokens(buildConfig(), {
      shopId: DEMO_SHOP_ID,
      shopDomain: DEMO_SHOP,
      clientId: CLIENT_ID,
    });
    expect(tokens.token_type).toBe("Bearer");
  });

  it("reports the configured access lifetime", async () => {
    const config = buildConfig({ tokenTtl: { access: 900 } });
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    expect(tokens.expires_in).toBe(900);
  });

  it("stores the access token hashed, never in plaintext", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    const stored = await config.storage.findTokenByAccessHash(sha256Hex(tokens.access_token));
    expect(stored).not.toBeNull();
    expect(await config.storage.findTokenByAccessHash(tokens.access_token)).toBeNull();
  });

  it("issues distinct access and refresh tokens", async () => {
    const tokens = await issueTokens(buildConfig(), {
      shopId: DEMO_SHOP_ID,
      shopDomain: DEMO_SHOP,
      clientId: CLIENT_ID,
    });
    expect(tokens.access_token).not.toBe(tokens.refresh_token);
  });
});

describe("rotateRefresh", () => {
  it("issues a new pair, preserving the shop, scope, resource, and rotation lineage", async () => {
    const config = buildConfig();
    const first = await issueTokens(config, {
      shopId: DEMO_SHOP_ID,
      shopDomain: DEMO_SHOP,
      clientId: CLIENT_ID,
      scope: CUSTOM_SCOPE,
      resource: CUSTOM_RESOURCE,
    });
    const originalRow = await config.storage.findTokenByRefreshHash(sha256Hex(first.refresh_token));

    const rotated = await rotateRefresh(config, first.refresh_token, CLIENT_ID);
    expect(rotated).not.toBeNull();
    expect(rotated?.access_token).not.toBe(first.access_token);

    const rotatedRow = await config.storage.findTokenByAccessHash(sha256Hex(rotated?.access_token ?? ""));
    expect(rotatedRow?.shopId).toBe(DEMO_SHOP_ID);
    expect(rotatedRow?.shopDomain).toBe(DEMO_SHOP);
    expect(rotatedRow?.scope).toBe(CUSTOM_SCOPE);
    expect(rotatedRow?.resource).toBe(CUSTOM_RESOURCE);
    expect(rotatedRow?.rotatedFromId).toBe(originalRow?.id);
  });

  it("refuses the same refresh token twice", async () => {
    const config = buildConfig();
    const first = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    await rotateRefresh(config, first.refresh_token, CLIENT_ID);
    expect(await rotateRefresh(config, first.refresh_token, CLIENT_ID)).toBeNull();
  });

  it("refuses a refresh token presented by a different client", async () => {
    const config = buildConfig();
    const first = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    expect(await rotateRefresh(config, first.refresh_token, "some-other-client")).toBeNull();
  });

  it("returns null for an unknown refresh token", async () => {
    expect(await rotateRefresh(buildConfig(), "never-issued", CLIENT_ID)).toBeNull();
  });

  it("lets only one of two concurrent rotations win", async () => {
    const config = buildConfig();
    const first = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    const [a, b] = await Promise.all([
      rotateRefresh(config, first.refresh_token, CLIENT_ID),
      rotateRefresh(config, first.refresh_token, CLIENT_ID),
    ]);
    const winners = [a, b].filter((result) => result !== null);
    expect(winners).toHaveLength(1);
  });
});

describe("revokeByAccessToken", () => {
  it("makes the access token unusable", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    await revokeByAccessToken(config, tokens.access_token);
    expect(await config.storage.findTokenByAccessHash(sha256Hex(tokens.access_token))).toBeNull();
  });

  it("revokes the grant even after the access token has expired", async () => {
    vi.useFakeTimers();
    try {
      const config = buildConfig({ tokenTtl: { access: 1 } });
      const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
      vi.advanceTimersByTime(2_000);

      await revokeByAccessToken(config, tokens.access_token);

      expect(await config.storage.findTokenByRefreshHash(sha256Hex(tokens.refresh_token))).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("revokeByRefreshToken", () => {
  it("makes the refresh token unusable", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    await revokeByRefreshToken(config, tokens.refresh_token);
    expect(await config.storage.findTokenByRefreshHash(sha256Hex(tokens.refresh_token))).toBeNull();
  });

  it("also makes the paired access token unusable", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    await revokeByRefreshToken(config, tokens.refresh_token);
    expect(await config.storage.findTokenByAccessHash(sha256Hex(tokens.access_token))).toBeNull();
  });

  it("is a no-op for an unknown refresh token", async () => {
    await expect(revokeByRefreshToken(buildConfig(), "never-issued")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter shopify-mcp-oauth test src/services/codes.test.ts src/services/tokens.test.ts`
Expected: FAIL — cannot resolve `./codes` and `./tokens`.

- [ ] **Step 3: Write `src/services/codes.ts`**

```ts
import type { ResolvedConfig } from "../config";
import { randomBase64Url, sha256Hex } from "../crypto";

const CODE_TTL_SECONDS = 60;
const CODE_PREFIX = "mcp:oauth:code:";

export interface CodeRecord {
  shopId: string | number;
  shopDomain: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string;
}

export async function issueCode(
  config: ResolvedConfig,
  input: CodeRecord & { ttlSeconds?: number }
): Promise<{ code: string }> {
  const code = randomBase64Url(32);
  const ttl = input.ttlSeconds ?? CODE_TTL_SECONDS;
  if (ttl > 0) {
    const record: CodeRecord = {
      shopId: input.shopId,
      shopDomain: input.shopDomain,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod,
      resource: input.resource,
    };
    // Keyed by the code's own hash, not the code itself, so a cache dump never yields a redeemable code.
    await config.cache.set(`${CODE_PREFIX}${sha256Hex(code)}`, JSON.stringify(record), ttl);
  }
  return { code };
}

export async function consumeCode(config: ResolvedConfig, code: string): Promise<CodeRecord | null> {
  const key = `${CODE_PREFIX}${sha256Hex(code)}`;
  // getdel is atomic on every CacheStore; that's what keeps a code single-use when two /token
  // requests race on it concurrently.
  const raw = await config.cache.getdel(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CodeRecord;
  } catch {
    // A cache entry that isn't valid JSON can't be a code this package wrote; treat it the same
    // as "not found" rather than letting a corrupt entry crash the /token request.
    return null;
  }
}
```

- [ ] **Step 4: Write `src/services/tokens.ts`**

```ts
import type { ResolvedConfig } from "../config";
import { randomBase64Url, sha256Hex } from "../crypto";

const DEFAULT_SCOPE = "mcp:*";

export interface IssuedTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: "Bearer";
}

export interface IssueTokensInput {
  shopId: string | number;
  shopDomain: string;
  clientId: string;
  scope?: string;
  resource?: string;
  rotatedFromId?: string | null;
}

export async function issueTokens(config: ResolvedConfig, input: IssueTokensInput): Promise<IssuedTokens> {
  const accessToken = randomBase64Url(32);
  const refreshToken = randomBase64Url(32);
  const scope = input.scope ?? DEFAULT_SCOPE;
  const now = Date.now();

  await config.storage.createToken({
    shopId: input.shopId,
    shopDomain: input.shopDomain,
    clientId: input.clientId,
    accessTokenHash: sha256Hex(accessToken),
    refreshTokenHash: sha256Hex(refreshToken),
    accessTokenExpiresAt: new Date(now + config.tokenTtl.access * 1000),
    refreshTokenExpiresAt: new Date(now + config.tokenTtl.refresh * 1000),
    scope,
    resource: input.resource ?? config.resource,
    rotatedFromId: input.rotatedFromId ?? null,
  });

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: config.tokenTtl.access,
    scope,
    token_type: "Bearer",
  };
}

export async function rotateRefresh(
  config: ResolvedConfig,
  refreshToken: string,
  clientId: string
): Promise<IssuedTokens | null> {
  const existing = await config.storage.findTokenByRefreshHash(sha256Hex(refreshToken));
  if (!existing) return null;
  // Bind rotation to the presenting client: a stolen refresh token is useless to a different one.
  if (existing.clientId !== clientId) return null;
  // Only the caller whose revoke actually flipped the row may mint a replacement, so two
  // concurrent refreshes of the same token can't both win.
  const won = await config.storage.revokeToken(existing.id);
  if (!won) return null;

  return issueTokens(config, {
    shopId: existing.shopId,
    shopDomain: existing.shopDomain,
    clientId: existing.clientId,
    scope: existing.scope ?? undefined,
    resource: existing.resource ?? undefined,
    rotatedFromId: existing.id,
  });
}

export async function revokeByAccessToken(config: ResolvedConfig, token: string): Promise<void> {
  // Ignores expiry deliberately: an access token that has expired since it was issued still
  // names a real grant, and revocation must be able to kill that grant's refresh token too.
  const existing = await config.storage.findTokenByAccessHashIgnoringExpiry(sha256Hex(token));
  if (existing) await config.storage.revokeToken(existing.id);
}

export async function revokeByRefreshToken(config: ResolvedConfig, token: string): Promise<void> {
  const existing = await config.storage.findTokenByRefreshHash(sha256Hex(token));
  if (existing) await config.storage.revokeToken(existing.id);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter shopify-mcp-oauth test src/services/codes.test.ts src/services/tokens.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/shopify-mcp-oauth/src/services/codes.ts packages/shopify-mcp-oauth/src/services/codes.test.ts packages/shopify-mcp-oauth/src/services/tokens.ts packages/shopify-mcp-oauth/src/services/tokens.test.ts
git commit -m "feat: add single-use authorization codes and rotating tokens"
```

---

## Task 14: Serializers, metadata, register, revoke, challenge

**Files:**
- Create: `packages/shopify-mcp-oauth/src/serializers/metadata.ts`, `register.ts`, `token.ts`
- Create: `packages/shopify-mcp-oauth/src/controllers/asyncHandler.ts`, `metadata.ts`, `register.ts`, `revoke.ts`, `openaiAppsChallenge.ts`
- Test: `packages/shopify-mcp-oauth/src/serializers/metadata.test.ts`, `packages/shopify-mcp-oauth/src/controllers/asyncHandler.test.ts`, `packages/shopify-mcp-oauth/src/controllers/metadata.test.ts`, `packages/shopify-mcp-oauth/src/controllers/register.test.ts`, `packages/shopify-mcp-oauth/src/controllers/revoke.test.ts`

**Interfaces:**
- Consumes: `ResolvedConfig`; `createDcrClient`; `revokeByAccessToken`, `revokeByRefreshToken`; `registerRequestSchema`; `revokeRequestSchema`; `Logger`
- Produces:
  - `asyncHandler(logger: Logger, handler): RequestHandler` — wraps a controller so a rejected promise (or synchronous throw) becomes a generic 500 instead of hanging the request or crashing the process. Express 4 does not forward a route handler's rejected promise to its error middleware on its own; every controller from here on is wrapped in this.
  - `serializeAuthorizationServerMetadata(config: ResolvedConfig): Record<string, unknown>`
  - `serializeProtectedResourceMetadata(config: ResolvedConfig): Record<string, unknown>`
  - `serializeClientRegistration(client: OAuthClient): Record<string, unknown>`
  - `serializeTokenBundle(tokens: IssuedTokens): Record<string, unknown>`
  - `authorizationServerMetadataController(config): RequestHandler`
  - `protectedResourceMetadataController(config): RequestHandler`
  - `registerController(config): RequestHandler`
  - `revokeController(config): RequestHandler`
  - `openaiAppsChallengeController(token: string | null): RequestHandler`

Revocation always answers 200, even for a token we have never seen. RFC 7009 requires it: a
distinguishable 404 would turn the endpoint into an oracle for guessing valid tokens.

- [ ] **Step 1: Write the failing tests**

`src/controllers/asyncHandler.test.ts`:

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../types";
import { asyncHandler } from "./asyncHandler";

function buildApp(logger: Logger, handler: Parameters<typeof asyncHandler>[1]) {
  const app = express();
  app.get("/probe", asyncHandler(logger, handler));
  return app;
}

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

describe("asyncHandler", () => {
  it("runs the wrapped handler and lets it respond normally", async () => {
    const app = buildApp(silentLogger, async (_req, res) => {
      res.status(201).json({ ok: true });
    });
    const response = await request(app).get("/probe");
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ ok: true });
  });

  it("turns a rejected promise into a generic 500 instead of hanging or crashing", async () => {
    const app = buildApp(silentLogger, async () => {
      throw new Error("storage unavailable: connection to db.internal.example refused");
    });
    const response = await request(app).get("/probe");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "server_error", error_description: "An unexpected error occurred" });
  });

  it("never lets the original error message or stack reach the response body", async () => {
    const app = buildApp(silentLogger, async () => {
      throw new Error("storage unavailable: connection to db.internal.example refused");
    });
    const response = await request(app).get("/probe");
    expect(JSON.stringify(response.body)).not.toContain("db.internal.example");
    expect(JSON.stringify(response.body)).not.toContain(".ts:");
  });

  it("logs the failure instead of swallowing it silently", async () => {
    const errorLog = vi.fn();
    const app = buildApp({ info: () => {}, warn: () => {}, error: errorLog }, async () => {
      throw new Error("boom");
    });
    await request(app).get("/probe");
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it("forwards to next(err) instead of double-responding once headers are already sent", async () => {
    const nextSpy = vi.fn();
    const app = express();
    app.get(
      "/probe",
      asyncHandler(silentLogger, async (_req, res) => {
        res.status(200).json({ ok: true });
        throw new Error("failure after the response was already flushed");
      })
    );
    app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      nextSpy(err);
      next(err);
    });
    const response = await request(app).get("/probe");
    expect(response.status).toBe(200);
    expect(nextSpy).toHaveBeenCalledTimes(1);
  });

  it("catches a synchronous throw from a handler that violates its own Promise<void> contract", async () => {
    // The signature promises a Promise, but nothing at runtime stops a caller from passing a
    // plain function that throws before ever returning one — the cast below is exactly that
    // violation, constructed on purpose to prove the wrapper survives it.
    const throwingHandler = ((_req: unknown, _res: unknown) => {
      throw new Error("sync boom");
    }) as unknown as Parameters<typeof asyncHandler>[1];
    const errorLog = vi.fn();
    const app = buildApp({ info: () => {}, warn: () => {}, error: errorLog }, throwingHandler);

    const response = await request(app).get("/probe");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "server_error", error_description: "An unexpected error occurred" });
    expect(errorLog).toHaveBeenCalledTimes(1);
  });
});
```

`src/serializers/metadata.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig, type ResolvedConfig } from "../config";
import { serializeAuthorizationServerMetadata, serializeProtectedResourceMetadata } from "./metadata";

const HOST = "https://mcp.example.com";

function buildConfig(): ResolvedConfig {
  return resolveConfig({
    host: HOST,
    shopify: { apiKey: "test-api-key", apiSecret: "test-api-secret", scopes: "read_products" },
    stateSecret: "test-state-secret-at-least-32-bytes-long",
    storage: memoryStorage(),
  });
}

describe("serializeAuthorizationServerMetadata", () => {
  it("advertises the issuer as the host", () => {
    expect(serializeAuthorizationServerMetadata(buildConfig()).issuer).toBe(HOST);
  });

  it("advertises every endpoint under the host", () => {
    const metadata = serializeAuthorizationServerMetadata(buildConfig());
    expect(metadata.authorization_endpoint).toBe(`${HOST}/authorize`);
    expect(metadata.token_endpoint).toBe(`${HOST}/token`);
    expect(metadata.registration_endpoint).toBe(`${HOST}/register`);
    expect(metadata.revocation_endpoint).toBe(`${HOST}/revoke`);
  });

  it("advertises S256 as the only challenge method", () => {
    expect(serializeAuthorizationServerMetadata(buildConfig()).code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("declares CIMD support so clients skip registration", () => {
    expect(serializeAuthorizationServerMetadata(buildConfig()).client_id_metadata_document_supported).toBe(true);
  });
});

describe("serializeProtectedResourceMetadata", () => {
  it("names the canonical resource", () => {
    expect(serializeProtectedResourceMetadata(buildConfig()).resource).toBe(`${HOST}/mcp`);
  });

  it("points back at this server as its authorization server", () => {
    expect(serializeProtectedResourceMetadata(buildConfig()).authorization_servers).toEqual([HOST]);
  });
});
```

`src/controllers/metadata.test.ts`:

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig } from "../config";
import { authorizationServerMetadataController, protectedResourceMetadataController } from "./metadata";
import { openaiAppsChallengeController } from "./openaiAppsChallenge";

const HOST = "https://mcp.example.com";
const CHALLENGE_TOKEN = "openai-challenge-token";

function buildConfig() {
  return resolveConfig({
    host: HOST,
    shopify: { apiKey: "test-api-key", apiSecret: "test-api-secret", scopes: "read_products" },
    stateSecret: "test-state-secret-at-least-32-bytes-long",
    storage: memoryStorage(),
  });
}

function buildApp() {
  const config = buildConfig();
  const app = express();
  app.get("/.well-known/oauth-authorization-server", authorizationServerMetadataController(config));
  app.get("/.well-known/oauth-protected-resource", protectedResourceMetadataController(config));
  app.get("/.well-known/openai-apps-challenge", openaiAppsChallengeController(CHALLENGE_TOKEN));
  return app;
}

describe("metadata controllers", () => {
  it("serves authorization server metadata as JSON", async () => {
    const response = await request(buildApp()).get("/.well-known/oauth-authorization-server");
    expect(response.status).toBe(200);
    expect(response.body.issuer).toBe(HOST);
  });

  it("serves protected resource metadata as JSON", async () => {
    const response = await request(buildApp()).get("/.well-known/oauth-protected-resource");
    expect(response.status).toBe(200);
    expect(response.body.resource).toBe(`${HOST}/mcp`);
  });

  it("echoes the configured challenge token", async () => {
    const response = await request(buildApp()).get("/.well-known/openai-apps-challenge");
    expect(response.text).toBe(CHALLENGE_TOKEN);
  });
});
```

`src/controllers/register.test.ts`:

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig, type ResolvedConfig } from "../config";
import type { Logger } from "../types";
import { registerController } from "./register";

const REDIRECT_URI = "https://client.example/callback";
const API_SECRET_CANARY = "test-api-secret";
const STATE_SECRET_CANARY = "test-state-secret-at-least-32-bytes-long";

// Only the "generic 500" test needs this — it deliberately triggers asyncHandler's error log,
// and the default console logger would print a stack trace on every full-suite run otherwise.
const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function buildConfig(overrides: { logger?: Logger } = {}): ResolvedConfig {
  return resolveConfig({
    host: "https://mcp.example.com",
    shopify: { apiKey: "test-api-key", apiSecret: API_SECRET_CANARY, scopes: "read_products" },
    stateSecret: STATE_SECRET_CANARY,
    storage: memoryStorage(),
    ...overrides,
  });
}

function buildApp(config: ResolvedConfig) {
  const app = express();
  app.use(express.json());
  app.post("/register", registerController(config));
  return app;
}

describe("registerController", () => {
  it("returns 201 with a generated client_id", async () => {
    const response = await request(buildApp(buildConfig()))
      .post("/register")
      .send({ redirect_uris: [REDIRECT_URI] });
    expect(response.status).toBe(201);
    expect(response.body.client_id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("echoes the registered redirect_uris", async () => {
    const response = await request(buildApp(buildConfig()))
      .post("/register")
      .send({ redirect_uris: [REDIRECT_URI] });
    expect(response.body.redirect_uris).toEqual([REDIRECT_URI]);
  });

  it("reports token_endpoint_auth_method none", async () => {
    const response = await request(buildApp(buildConfig()))
      .post("/register")
      .send({ redirect_uris: [REDIRECT_URI] });
    expect(response.body.token_endpoint_auth_method).toBe("none");
  });

  it("never returns a client_secret", async () => {
    const response = await request(buildApp(buildConfig()))
      .post("/register")
      .send({ redirect_uris: [REDIRECT_URI] });
    expect(response.body.client_secret).toBeUndefined();
  });

  it("rejects a body with no redirect_uris", async () => {
    const response = await request(buildApp(buildConfig())).post("/register").send({ client_name: "No Redirects" });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_client_metadata");
  });

  it("rejects a dangerous redirect_uri scheme", async () => {
    const response = await request(buildApp(buildConfig()))
      .post("/register")
      .send({ redirect_uris: ["javascript:alert(1)"] });
    expect(response.status).toBe(400);
  });

  it("does not persist a client when the redirect_uri is rejected", async () => {
    const config = buildConfig();
    const createClientSpy = vi.spyOn(config.storage, "createClient");
    const response = await request(buildApp(config))
      .post("/register")
      .send({ redirect_uris: ["javascript:alert(1)"] });
    expect(response.status).toBe(400);
    expect(createClientSpy).not.toHaveBeenCalled();
  });

  it("serializes only the validation message, never the raw issue object", async () => {
    const response = await request(buildApp(buildConfig())).post("/register").send({ client_name: "No Redirects" });
    // Asserting the whole body (not just error_description) means a sibling key carrying the raw
    // issue — e.g. a `debug` field — would fail this too, not just a corrupted error_description.
    expect(response.body).toEqual({
      error: "invalid_client_metadata",
      error_description: "redirect_uris must contain at least one entry",
    });
  });

  it("returns a generic 500 without a stack trace when the client store fails", async () => {
    const config = buildConfig({ logger: silentLogger });
    vi.spyOn(config.storage, "createClient").mockRejectedValue(
      new Error("storage unavailable: connection to db.internal.example refused")
    );
    const response = await request(buildApp(config))
      .post("/register")
      .send({ redirect_uris: [REDIRECT_URI] });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "server_error", error_description: "An unexpected error occurred" });
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain("db.internal.example");
    expect(raw).not.toContain(API_SECRET_CANARY);
    expect(raw).not.toContain(STATE_SECRET_CANARY);
  });
});
```

`src/controllers/revoke.test.ts`:

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig, type ResolvedConfig } from "../config";
import { sha256Hex } from "../crypto";
import { issueTokens } from "../services/tokens";
import type { Logger } from "../types";
import { revokeController } from "./revoke";

const DEMO_SHOP = "example.myshopify.com";
const DEMO_SHOP_ID = "shop_1";
const CLIENT_ID = "test-client-id";
const API_SECRET_CANARY = "test-api-secret";
const STATE_SECRET_CANARY = "test-state-secret-at-least-32-bytes-long";

// Only the "generic 500" test needs this — it deliberately triggers asyncHandler's error log,
// and the default console logger would print a stack trace on every full-suite run otherwise.
const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function buildApp(config: ResolvedConfig) {
  const app = express();
  app.use(express.json());
  app.post("/revoke", revokeController(config));
  return app;
}

function buildConfig(
  overrides: { tokenTtl?: { access?: number; refresh?: number }; logger?: Logger } = {}
): ResolvedConfig {
  return resolveConfig({
    host: "https://mcp.example.com",
    shopify: { apiKey: "test-api-key", apiSecret: API_SECRET_CANARY, scopes: "read_products" },
    stateSecret: STATE_SECRET_CANARY,
    storage: memoryStorage(),
    ...overrides,
  });
}

// Headers carry state too — strip only Date, which ticks between requests regardless of what
// happened, and would otherwise make two truly-identical responses look different.
function headersMinusDate(response: request.Response): Record<string, string> {
  const { date: _date, ...rest } = response.headers as Record<string, string>;
  return rest;
}

describe("revokeController", () => {
  it("revokes a live access token", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    const response = await request(buildApp(config)).post("/revoke").send({ token: tokens.access_token });
    expect(response.status).toBe(200);
    expect(await config.storage.findTokenByAccessHash(sha256Hex(tokens.access_token))).toBeNull();
  });

  it("revokes a refresh token when hinted", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    const response = await request(buildApp(config))
      .post("/revoke")
      .send({ token: tokens.refresh_token, token_type_hint: "refresh_token" });
    expect(response.status).toBe(200);
    expect(await config.storage.findTokenByRefreshHash(sha256Hex(tokens.refresh_token))).toBeNull();
  });

  it("answers 200 for a token it has never seen, so it is not an oracle", async () => {
    const response = await request(buildApp(buildConfig())).post("/revoke").send({ token: "never-issued" });
    expect(response.status).toBe(200);
  });

  it("returns an identical status, body, and headers for a real token and a fake one, so the two are indistinguishable", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    const realResponse = await request(buildApp(config)).post("/revoke").send({ token: tokens.access_token });
    const fakeResponse = await request(buildApp(buildConfig())).post("/revoke").send({ token: "never-issued" });
    expect(realResponse.status).toBe(fakeResponse.status);
    expect(realResponse.body).toEqual(fakeResponse.body);
    expect(headersMinusDate(realResponse)).toEqual(headersMinusDate(fakeResponse));
  });

  it("returns an identical status, body, and headers for a real refresh token and a fake one when hinted, so the two are indistinguishable", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    const realResponse = await request(buildApp(config))
      .post("/revoke")
      .send({ token: tokens.refresh_token, token_type_hint: "refresh_token" });
    const fakeResponse = await request(buildApp(buildConfig()))
      .post("/revoke")
      .send({ token: "never-issued", token_type_hint: "refresh_token" });
    expect(realResponse.status).toBe(fakeResponse.status);
    expect(realResponse.body).toEqual(fakeResponse.body);
    expect(headersMinusDate(realResponse)).toEqual(headersMinusDate(fakeResponse));
  });

  it("revokes the grant even after the access token has expired", async () => {
    vi.useFakeTimers();
    try {
      const config = buildConfig({ tokenTtl: { access: 1 } });
      const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
      vi.advanceTimersByTime(2_000);

      const response = await request(buildApp(config)).post("/revoke").send({ token: tokens.access_token });

      expect(response.status).toBe(200);
      expect(await config.storage.findTokenByRefreshHash(sha256Hex(tokens.refresh_token))).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a body with no token", async () => {
    const response = await request(buildApp(buildConfig())).post("/revoke").send({});
    expect(response.status).toBe(400);
  });

  it("serializes only the validation message, never the raw issue object", async () => {
    const response = await request(buildApp(buildConfig())).post("/revoke").send({});
    // Asserting the whole body (not just error_description) means a sibling key carrying the raw
    // issue — e.g. a `debug` field — would fail this too, not just a corrupted error_description.
    expect(response.body).toEqual({
      error: "invalid_request",
      error_description: "token is required",
    });
  });

  it("returns a generic 500 without a stack trace when the token store fails", async () => {
    const config = buildConfig({ logger: silentLogger });
    vi.spyOn(config.storage, "findTokenByAccessHashIgnoringExpiry").mockRejectedValue(
      new Error("storage unavailable: connection to db.internal.example refused")
    );
    const response = await request(buildApp(config)).post("/revoke").send({ token: "some-token" });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "server_error", error_description: "An unexpected error occurred" });
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain("db.internal.example");
    expect(raw).not.toContain(API_SECRET_CANARY);
    expect(raw).not.toContain(STATE_SECRET_CANARY);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter shopify-mcp-oauth test src/serializers src/controllers`
Expected: FAIL — none of the serializer or controller modules resolve.

- [ ] **Step 3: Write the serializers**

`src/serializers/metadata.ts`:

```ts
import type { ResolvedConfig } from "../config";

export function serializeAuthorizationServerMetadata(config: ResolvedConfig): Record<string, unknown> {
  return {
    issuer: config.host,
    authorization_endpoint: `${config.host}/authorize`,
    token_endpoint: `${config.host}/token`,
    registration_endpoint: `${config.host}/register`,
    revocation_endpoint: `${config.host}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["mcp:*"],
    client_id_metadata_document_supported: true,
  };
}

export function serializeProtectedResourceMetadata(config: ResolvedConfig): Record<string, unknown> {
  return {
    resource: config.resource,
    authorization_servers: [config.host],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp:*"],
  };
}
```

`src/serializers/register.ts`:

```ts
import type { OAuthClient } from "../types";

export function serializeClientRegistration(client: OAuthClient): Record<string, unknown> {
  return {
    client_id: client.clientId,
    client_name: client.clientName ?? undefined,
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes ?? ["authorization_code", "refresh_token"],
    response_types: client.responseTypes ?? ["code"],
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    logo_uri: client.logoUri ?? undefined,
    client_uri: client.clientUri ?? undefined,
  };
}
```

`src/serializers/token.ts`:

```ts
import type { IssuedTokens } from "../services/tokens";

export function serializeTokenBundle(tokens: IssuedTokens): Record<string, unknown> {
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type,
    expires_in: tokens.expires_in,
    scope: tokens.scope,
  };
}
```

- [ ] **Step 4: Write the controllers**

`src/controllers/asyncHandler.ts`:

```ts
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Logger } from "../types";

type AsyncControllerHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

const GENERIC_SERVER_ERROR_BODY = { error: "server_error", error_description: "An unexpected error occurred" };

// Express 4 drops a route handler's rejected promise on the floor — the request hangs, and
// Node's default unhandled-rejection policy then kills the process. Express 5 forwards the
// rejection to next(err) on its own, but this package can't assume the consumer mounted a
// terminal error handler downstream, so this wrapper owns the response itself rather than
// leaving an unauthenticated caller to whatever (if anything) Express's own default handler
// would have sent — including a stack trace, which it prints outside of NODE_ENV=production.
export function asyncHandler(logger: Logger, handler: AsyncControllerHandler): RequestHandler {
  return (req, res, next) => {
    // The type says handler always returns a Promise, and a genuinely `async` function can't
    // violate that — but nothing at the type level stops a caller from passing a plain function
    // that throws before ever returning one, and this seam is about to carry several more
    // controllers (Tasks 15-17). Routing the call through Promise.resolve().then(...) means a
    // synchronous throw lands in the same .catch() as a real rejection, so it still gets this
    // package's generic response instead of whatever Express's own default handler would have
    // sent. Not a live bug today — every controller built so far is a true async function.
    Promise.resolve()
      .then(() => handler(req, res, next))
      .catch((err: unknown) => {
        if (res.headersSent) {
          next(err);
          return;
        }
        logger.error("shopify-mcp-oauth: unhandled controller error", err);
        res.status(500).json(GENERIC_SERVER_ERROR_BODY);
      });
  };
}
```

`src/controllers/metadata.ts`:

```ts
import type { RequestHandler } from "express";
import type { ResolvedConfig } from "../config";
import { serializeAuthorizationServerMetadata, serializeProtectedResourceMetadata } from "../serializers/metadata";

export function authorizationServerMetadataController(config: ResolvedConfig): RequestHandler {
  const body = serializeAuthorizationServerMetadata(config);
  return (_req, res) => {
    res.status(200).json(body);
  };
}

export function protectedResourceMetadataController(config: ResolvedConfig): RequestHandler {
  const body = serializeProtectedResourceMetadata(config);
  return (_req, res) => {
    res.status(200).json(body);
  };
}
```

`src/controllers/register.ts`:

```ts
import type { RequestHandler } from "express";
import type { ResolvedConfig } from "../config";
import { registerRequestSchema } from "../schemas/register";
import { serializeClientRegistration } from "../serializers/register";
import { createDcrClient } from "../services/clients";
import { asyncHandler } from "./asyncHandler";

export function registerController(config: ResolvedConfig): RequestHandler {
  return asyncHandler(config.logger, async (req, res) => {
    const parsed = registerRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_client_metadata",
        error_description: parsed.error.issues[0]?.message ?? "body must be a JSON object",
      });
      return;
    }
    const client = await createDcrClient(config, parsed.data);
    res.status(201).json(serializeClientRegistration(client));
  });
}
```

`src/controllers/revoke.ts`:

```ts
import type { RequestHandler } from "express";
import type { ResolvedConfig } from "../config";
import { revokeRequestSchema } from "../schemas/revoke";
import { revokeByAccessToken, revokeByRefreshToken } from "../services/tokens";
import { asyncHandler } from "./asyncHandler";

export function revokeController(config: ResolvedConfig): RequestHandler {
  return asyncHandler(config.logger, async (req, res) => {
    const parsed = revokeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_request",
        error_description: parsed.error.issues[0]?.message ?? "token is required",
      });
      return;
    }
    // RFC 7009 §2.2: answer 200 whether or not the token existed, so the endpoint cannot be
    // used to test token guesses.
    if (parsed.data.token_type_hint === "refresh_token") {
      await revokeByRefreshToken(config, parsed.data.token);
    } else {
      await revokeByAccessToken(config, parsed.data.token);
      await revokeByRefreshToken(config, parsed.data.token);
    }
    res.status(200).json({});
  });
}
```

`src/controllers/openaiAppsChallenge.ts`:

```ts
import type { RequestHandler } from "express";

export function openaiAppsChallengeController(token: string | null): RequestHandler {
  return (_req, res) => {
    if (!token) {
      res.status(404).type("text/plain").send("not configured");
      return;
    }
    res.status(200).type("text/plain").send(token);
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter shopify-mcp-oauth test src/serializers src/controllers`
Expected: PASS, 34 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/shopify-mcp-oauth/src/serializers packages/shopify-mcp-oauth/src/controllers
git commit -m "feat: add metadata, registration, revocation, and challenge endpoints"
```

---

## Task 15: Authorize controller

**Files:**
- Create: `packages/shopify-mcp-oauth/src/controllers/authorize.ts`
- Test: `packages/shopify-mcp-oauth/src/controllers/authorize.test.ts`

**Interfaces:**
- Consumes: `ResolvedConfig`; `authorizeQuerySchema`; `isCimdClientId`, `resolveCimdClient`; `redirectUriMatches`; `signOuterState`; `randomBase64Url`
- Produces:
  - `interface AuthorizeControllerOptions { allowPrivateCimdHosts?: boolean }`
  - `authorizeController(config: ResolvedConfig, options?: AuthorizeControllerOptions): RequestHandler`

`/authorize` never renders a consent screen. Shop ownership *is* the consent, so it validates the
client and redirects the browser to Shopify's shop picker with a signed state JWT carrying the whole
original request.

An invalid request is answered as a 400 rather than a redirect, because a redirect to an unverified
`redirect_uri` would make this endpoint an open redirector.

- [ ] **Step 1: Write the failing test**

`src/controllers/authorize.test.ts`:

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig, type ResolvedConfig } from "../config";
import { sha256Base64Url } from "../crypto";
import { verifyOuterState } from "../services/stateJwt";
import type { Logger } from "../types";
import { authorizeController } from "./authorize";

const HOST = "https://mcp.example.com";
const STATE_SECRET = "test-state-secret-at-least-32-bytes-long";
const SHOPIFY_API_KEY = "test-api-key";
const API_SECRET_CANARY = "test-api-secret";
const CIMD_URL = "https://client.example/metadata.json";
const REDIRECT_URI = "https://client.example/callback";
const CLIENT_STATE = "client-state-value";
// RFC 7636 Appendix B.1 test vector (same pair used in crypto.test.ts / schemas.test.ts), with the
// challenge derived via this package's own sha256Base64Url rather than a hand-typed placeholder —
// so a later full-flow test (Task 21) can redeem a code using this exact verifier.
const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CODE_CHALLENGE = sha256Base64Url(CODE_VERIFIER);

// Only the "generic 500" test needs this — it deliberately triggers asyncHandler's error log,
// and the default console logger would print a stack trace on every full-suite run otherwise.
const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function buildConfig(overrides: { logger?: Logger; fetchImpl?: typeof fetch } = {}): ResolvedConfig {
  const cimdResponse = new Response(JSON.stringify({ client_name: "Test Client", redirect_uris: [REDIRECT_URI] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  return resolveConfig({
    host: HOST,
    shopify: { apiKey: SHOPIFY_API_KEY, apiSecret: API_SECRET_CANARY, scopes: "read_products" },
    stateSecret: STATE_SECRET,
    storage: memoryStorage(),
    fetchImpl: vi.fn().mockResolvedValue(cimdResponse) as unknown as typeof fetch,
    ...overrides,
  });
}

function buildApp(config: ResolvedConfig) {
  const app = express();
  app.get("/authorize", authorizeController(config, { allowPrivateCimdHosts: true }));
  return app;
}

// No options object at all -- the shape a real deployment mounts the controller with. Exists
// specifically to prove the SSRF guard is actually on by default; every other test in this file
// uses buildApp above, which opts into the private-host escape hatch for test convenience.
function buildAppWithDefaultCimdHosts(config: ResolvedConfig) {
  const app = express();
  app.get("/authorize", authorizeController(config));
  return app;
}

// supertest/superagent types response.headers as a plain string-keyed record, so
// noUncheckedIndexedAccess widens response.headers.location to string | undefined even though a
// 302 always sets it — every caller here already depends on that redirect having happened.
function redirectLocation(response: request.Response): string {
  return response.headers.location ?? "";
}

function extractOuterState(response: request.Response) {
  const redirectParam = new URL(redirectLocation(response)).searchParams.get("redirect") ?? "";
  const stateJwt = new URLSearchParams(redirectParam.split("?")[1]).get("state") ?? "";
  return verifyOuterState(stateJwt, STATE_SECRET);
}

const validQuery = {
  response_type: "code",
  client_id: CIMD_URL,
  redirect_uri: REDIRECT_URI,
  state: CLIENT_STATE,
  code_challenge: CODE_CHALLENGE,
  code_challenge_method: "S256",
};

describe("authorizeController", () => {
  it("redirects to Shopify's shop picker", async () => {
    const response = await request(buildApp(buildConfig())).get("/authorize").query(validQuery);
    expect(response.status).toBe(302);
    expect(response.headers.location).toContain("https://admin.shopify.com/");
  });

  it("asks Shopify for our app, with our callback", async () => {
    const response = await request(buildApp(buildConfig())).get("/authorize").query(validQuery);
    const redirectParam = new URL(redirectLocation(response)).searchParams.get("redirect") ?? "";
    expect(redirectParam).toContain(`client_id=${SHOPIFY_API_KEY}`);
    expect(redirectParam).toContain(encodeURIComponent(`${HOST}/oauth/shopify-callback`));
  });

  it("carries the original request inside a signed state JWT", async () => {
    // All 7 outerStatePayloadSchema fields, not a subset: codeChallengeMethod in particular is a
    // PKCE-downgrade guard (S256-only is a binding constraint Tasks 16/17 rely on), and resource
    // is what ties the eventual token back to this specific audience.
    const response = await request(buildApp(buildConfig())).get("/authorize").query(validQuery);
    const verified = extractOuterState(response);
    expect(verified.clientId).toBe(CIMD_URL);
    expect(verified.redirectUri).toBe(REDIRECT_URI);
    expect(verified.clientState).toBe(CLIENT_STATE);
    expect(verified.codeChallenge).toBe(CODE_CHALLENGE);
    expect(verified.codeChallengeMethod).toBe("S256");
    expect(verified.resource).toBe(`${HOST}/mcp`);
    expect(verified.nonce.length).toBeGreaterThan(0);
  });

  it("signs a fresh nonce on every authorize call", async () => {
    const firstResponse = await request(buildApp(buildConfig())).get("/authorize").query(validQuery);
    const secondResponse = await request(buildApp(buildConfig())).get("/authorize").query(validQuery);
    expect(extractOuterState(firstResponse).nonce).not.toBe(extractOuterState(secondResponse).nonce);
  });

  it("rejects a redirect_uri the client did not register", async () => {
    const response = await request(buildApp(buildConfig()))
      .get("/authorize")
      .query({ ...validQuery, redirect_uri: "https://attacker.example/callback" });
    expect(response.status).toBe(400);
    expect(response.body.error_description).toMatch(/not registered/);
  });

  it("rejects a resource that is not ours", async () => {
    const response = await request(buildApp(buildConfig()))
      .get("/authorize")
      .query({ ...validQuery, resource: "https://other.example/mcp" });
    expect(response.status).toBe(400);
  });

  it("accepts our canonical resource", async () => {
    const response = await request(buildApp(buildConfig()))
      .get("/authorize")
      .query({ ...validQuery, resource: `${HOST}/mcp` });
    expect(response.status).toBe(302);
  });

  it("rejects a plain code_challenge_method", async () => {
    const response = await request(buildApp(buildConfig()))
      .get("/authorize")
      .query({ ...validQuery, code_challenge_method: "plain" });
    expect(response.status).toBe(400);
  });

  it("rejects an unknown registered client_id", async () => {
    const response = await request(buildApp(buildConfig()))
      .get("/authorize")
      .query({ ...validQuery, client_id: "never-registered" });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_client");
  });

  it("accepts a client registered through DCR", async () => {
    const config = buildConfig();
    const registered = await config.storage.createClient({
      clientId: "registered-client-id",
      clientName: "Registered Client",
      redirectUris: [REDIRECT_URI],
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      logoUri: null,
      clientUri: null,
      tokenEndpointAuthMethod: "none",
    });
    const response = await request(buildApp(config))
      .get("/authorize")
      .query({ ...validQuery, client_id: registered.clientId });
    expect(response.status).toBe(302);
  });

  it("serializes only the validation message, never the raw issue object", async () => {
    const { code_challenge_method: omittedChallengeMethod, ...queryWithoutChallengeMethod } = validQuery;
    void omittedChallengeMethod;
    const response = await request(buildApp(buildConfig())).get("/authorize").query(queryWithoutChallengeMethod);
    // Asserting the whole body (not just error_description) means a sibling key carrying the raw
    // issue — e.g. a `debug` field — would fail this too, not just a corrupted error_description.
    expect(response.body).toEqual({
      error: "invalid_request",
      error_description: "code_challenge_method must be S256",
    });
  });

  it("returns a generic 500 without a stack trace when the client store fails", async () => {
    const config = buildConfig({ logger: silentLogger });
    vi.spyOn(config.storage, "findClient").mockRejectedValue(
      new Error("storage unavailable: connection to db.internal.example refused")
    );
    const response = await request(buildApp(config))
      .get("/authorize")
      // A plain (non-CIMD) client_id, so this exercises the storage.findClient branch directly
      // rather than routing through resolveCimdClient's own error handling.
      .query({ ...validQuery, client_id: "registered-client-id" });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "server_error", error_description: "An unexpected error occurred" });
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain("db.internal.example");
    expect(raw).not.toContain(API_SECRET_CANARY);
    expect(raw).not.toContain(STATE_SECRET);
  });

  it("returns a generic 500 without leaking internal detail when CIMD resolution's storage lookup fails", async () => {
    // resolveCimdClient checks storage before the network (see services/cimd.ts), so a CIMD
    // client_id still reaches config.storage.findClient. That lookup is deliberately unguarded
    // inside resolveCimdClient — a storage outage is an infrastructure failure, not a statement
    // about the client's own document, and must reach asyncHandler's generic 500 rather than
    // being reflected into a 400 body as (error as Error).message would have done.
    const config = buildConfig({ logger: silentLogger });
    vi.spyOn(config.storage, "findClient").mockRejectedValue(
      new Error("storage unavailable: connection to db.internal.example refused")
    );
    const response = await request(buildApp(config)).get("/authorize").query(validQuery);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "server_error", error_description: "An unexpected error occurred" });
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain("db.internal.example");
    expect(raw).not.toContain(API_SECRET_CANARY);
    expect(raw).not.toContain(STATE_SECRET);
  });

  it("rejects a client whose CIMD document is genuinely invalid, naming the reason", async () => {
    const invalidDocumentResponse = new Response(JSON.stringify({ client_name: "Invalid Client", redirect_uris: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const config = buildConfig({
      fetchImpl: vi.fn().mockResolvedValue(invalidDocumentResponse) as unknown as typeof fetch,
    });
    const response = await request(buildApp(config)).get("/authorize").query(validQuery);
    // Exact match, not a substring/regex check: bad(res, error.description, error.code) must not
    // double up the OAuthError's own "invalid_client: " message prefix on top of error.code.
    expect(response.body).toEqual({
      error: "invalid_client",
      error_description: "redirect_uris: CIMD document missing redirect_uris[]",
    });
    expect(response.status).toBe(400);
  });

  it("returns 400, not 500, when the CIMD host is unreachable, and does not log a stack trace", async () => {
    const errorSpy = vi.fn();
    const config = buildConfig({
      logger: { info: () => {}, warn: () => {}, error: errorSpy },
      fetchImpl: vi.fn().mockRejectedValue(new TypeError("fetch failed")) as unknown as typeof fetch,
    });
    const response = await request(buildApp(config)).get("/authorize").query(validQuery);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_client");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("returns 400, not 500, for a malformed client_id URL, and does not log a stack trace", async () => {
    const errorSpy = vi.fn();
    const config = buildConfig({ logger: { info: () => {}, warn: () => {}, error: errorSpy } });
    const response = await request(buildApp(config))
      .get("/authorize")
      .query({ ...validQuery, client_id: "https://[" });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_client");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("rejects a private-host CIMD client_id when allowPrivateCimdHosts is not set (the production default)", async () => {
    // buildAppWithDefaultCimdHosts, not buildApp -- proving the SSRF guard is actually on unless a
    // caller opts out, not merely that it CAN reject a private host when told to.
    const response = await request(buildAppWithDefaultCimdHosts(buildConfig()))
      .get("/authorize")
      .query({ ...validQuery, client_id: "https://127.0.0.1/metadata.json" });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_client");
  });

  it("never embeds a secret in the bounce URL, and pins the picker's shape", async () => {
    const response = await request(buildApp(buildConfig())).get("/authorize").query(validQuery);
    const location = redirectLocation(response);
    expect(location).not.toContain(API_SECRET_CANARY);
    expect(location).not.toContain(STATE_SECRET);
    const shopPickerUrl = new URL(location);
    expect(shopPickerUrl.host).toBe("admin.shopify.com");
    expect(shopPickerUrl.searchParams.get("no_redirect")).toBe("true");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter shopify-mcp-oauth test src/controllers/authorize.test.ts`
Expected: FAIL — cannot resolve `./authorize`.

- [ ] **Step 3: Write `src/controllers/authorize.ts`**

```ts
import type { RequestHandler, Response } from "express";
import type { ResolvedConfig } from "../config";
import { randomBase64Url } from "../crypto";
import { OAuthError } from "../errors";
import { authorizeQuerySchema } from "../schemas/authorize";
import { isCimdClientId, resolveCimdClient } from "../services/cimd";
import { redirectUriMatches } from "../services/redirectUri";
import { signOuterState } from "../services/stateJwt";
import { asyncHandler } from "./asyncHandler";

const STATE_TTL_SECONDS = 600;
const NONCE_BYTES = 16;

export interface AuthorizeControllerOptions {
  allowPrivateCimdHosts?: boolean;
}

function bad(res: Response, description: string, code = "invalid_request"): void {
  // Answered as a 400 rather than a redirect: bouncing to an unvalidated redirect_uri would
  // make /authorize an open redirector.
  res.status(400).json({ error: code, error_description: description });
}

export function authorizeController(config: ResolvedConfig, options: AuthorizeControllerOptions = {}): RequestHandler {
  return asyncHandler(config.logger, async (req, res) => {
    const parsed = authorizeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return bad(res, parsed.error.issues[0]?.message ?? "invalid query");
    }
    const query = parsed.data;

    const resource = query.resource ?? config.resource;
    if (resource !== config.resource) {
      return bad(res, `resource must equal ${config.resource}`);
    }

    let registeredRedirectUris: string[];
    if (isCimdClientId(query.client_id)) {
      try {
        const doc = await resolveCimdClient(config, query.client_id, {
          allowPrivateHosts: options.allowPrivateCimdHosts,
        });
        registeredRedirectUris = doc.redirect_uris;
      } catch (error) {
        // Only an OAuthError is a judgment about the client's own client_id/document — safe to
        // name on this unauthenticated endpoint. Anything else (e.g. the storage lookup inside
        // resolveCimdClient failing) is an infrastructure error and must fall through to
        // asyncHandler's generic 500 instead of reflecting internal detail into a 400 body.
        if (!(error instanceof OAuthError)) throw error;
        return bad(res, error.description, error.code);
      }
    } else {
      const client = await config.storage.findClient(query.client_id);
      if (!client) return bad(res, "unknown client_id", "invalid_client");
      registeredRedirectUris = client.redirectUris;
    }

    if (!registeredRedirectUris.some((registered) => redirectUriMatches(registered, query.redirect_uri))) {
      return bad(res, "redirect_uri not registered for this client");
    }

    const state = signOuterState(
      {
        clientId: query.client_id,
        redirectUri: query.redirect_uri,
        clientState: query.state,
        codeChallenge: query.code_challenge,
        codeChallengeMethod: query.code_challenge_method,
        resource,
        nonce: randomBase64Url(NONCE_BYTES),
      },
      config.stateSecret,
      STATE_TTL_SECONDS
    );

    const shopifyQuery = new URLSearchParams({
      response_type: "code",
      client_id: config.shopify.apiKey,
      redirect_uri: `${config.host}/oauth/shopify-callback`,
      scope: config.shopify.scopes,
      state,
    });

    // admin.shopify.com renders the shop picker, then replays this path against the shop the
    // merchant chooses. That picker is the consent step — shop ownership is the consent.
    const shopPicker = new URL("https://admin.shopify.com/");
    shopPicker.searchParams.set("redirect", `/oauth/authorize?${shopifyQuery.toString()}`);
    shopPicker.searchParams.set("no_redirect", "true");
    res.redirect(shopPicker.toString());
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter shopify-mcp-oauth test src/controllers/authorize.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shopify-mcp-oauth/src/controllers/authorize.ts packages/shopify-mcp-oauth/src/controllers/authorize.test.ts
git commit -m "feat: add /authorize with client validation and the Shopify bounce"
```

---

## Task 16: Shopify HMAC middleware and callback controller

**Files:**
- Create: `packages/shopify-mcp-oauth/src/middlewares/verifyShopifyHmac.ts`
- Create: `packages/shopify-mcp-oauth/src/controllers/shopifyCallback.ts`
- Test: `packages/shopify-mcp-oauth/src/middlewares/verifyShopifyHmac.test.ts`, `packages/shopify-mcp-oauth/src/controllers/shopifyCallback.test.ts`

**Interfaces:**
- Consumes: `ResolvedConfig`; `shopifyCallbackQuerySchema`; `verifyOuterState`; `issueCode`; `safeEqual`
- Produces:
  - `verifyShopifyHmac(queryString: string, secret: string): boolean`
  - `requireShopifyHmac(secret: string): RequestHandler`
  - `shopifyCallbackController(config: ResolvedConfig): RequestHandler`

This is where the merchant's identity is established. Three checks run in order, and all three must
pass before a code is issued:

1. **HMAC** — proves Shopify sent this callback. Shopify signs the *raw* query string it emitted, so
   the message must be rebuilt from `req.originalUrl`, never from `req.query` (re-encoding decoded
   values produces a different base string for parameters like `redirect_uri`).
2. **State JWT** — proves the flow started at our own `/authorize` with these exact parameters.
3. **Token exchange** — a server-to-server call proving the merchant controls this shop. The resulting
   Shopify access token is discarded; it was only ever the proof.

Then the shop must already be known to the app, or the callback answers 403.

- [ ] **Step 1: Write the failing tests**

`src/middlewares/verifyShopifyHmac.test.ts`:

```ts
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { requireShopifyHmac, verifyShopifyHmac } from "./verifyShopifyHmac";

const API_SECRET = "test-api-secret";
const DEMO_SHOP = "demo.myshopify.com";

function signQuery(params: Record<string, string>): string {
  // Sorted by key, mirroring the algorithm verifyShopifyHmac itself applies (and the one
  // Shopify's docs document for the sibling installation-request HMAC) -- this is what makes
  // signQuery an accurate stand-in for "how Shopify signs a callback", not just "any string this
  // suite's own signer and verifier happen to agree on".
  const sortedEntries = Object.entries(params).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const message = new URLSearchParams(sortedEntries).toString();
  const hmac = crypto.createHmac("sha256", API_SECRET).update(message).digest("hex");
  return `${message}&hmac=${hmac}`;
}

describe("verifyShopifyHmac", () => {
  it("accepts a query Shopify signed", () => {
    expect(verifyShopifyHmac(signQuery({ shop: DEMO_SHOP, code: "abc" }), API_SECRET)).toBe(true);
  });

  it("rejects a query with no hmac", () => {
    expect(verifyShopifyHmac(`shop=${DEMO_SHOP}&code=abc`, API_SECRET)).toBe(false);
  });

  it("rejects a tampered parameter", () => {
    const signed = signQuery({ shop: DEMO_SHOP, code: "abc" });
    expect(verifyShopifyHmac(signed.replace("code=abc", "code=xyz"), API_SECRET)).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    expect(verifyShopifyHmac(signQuery({ shop: DEMO_SHOP }), "a-different-secret")).toBe(false);
  });

  it("fails closed instead of throwing when the hmac value is malformed percent-encoding", () => {
    // decodeURIComponent throws a URIError on a lone "%"; this pins the guard's own failure mode
    // (return false) rather than letting that throw escape into an unhandled middleware crash.
    expect(() => verifyShopifyHmac(`shop=${DEMO_SHOP}&hmac=%`, API_SECRET)).not.toThrow();
    expect(verifyShopifyHmac(`shop=${DEMO_SHOP}&hmac=%`, API_SECRET)).toBe(false);
  });

  it("verifies a raw %20-encoded space, which a decode/re-encode round trip would turn into a +", () => {
    // A space is %20 in a raw query string but re-serializes as + under URLSearchParams (or
    // querystring.stringify) once it has been decoded -- so a signed message built from the raw
    // bytes and one rebuilt from the decoded value diverge for this exact byte, and only the raw
    // one is what Shopify actually signed.
    const rawQueryWithoutHmac = `shop=${DEMO_SHOP}&state=a%20b`;
    const hmac = crypto.createHmac("sha256", API_SECRET).update(rawQueryWithoutHmac).digest("hex");
    expect(verifyShopifyHmac(`${rawQueryWithoutHmac}&hmac=${hmac}`, API_SECRET)).toBe(true);
  });

  it("verifies a query whose parameters were received out of alphabetical order", () => {
    // Shopify's own callback field set (code, hmac, host, shop, state, timestamp) already arrives
    // in alphabetical order in practice, which is exactly the coincidence that let an
    // un-sorted implementation pass every other test in this file. Reorder deliberately, and sign
    // over the *sorted* base string per the documented algorithm: this only holds if
    // verifyShopifyHmac actually sorts before hashing, not merely joins whatever order it received.
    const rawOutOfOrder = `timestamp=1700000000&shop=${DEMO_SHOP}&code=abc`;
    const sortedBase = `code=abc&shop=${DEMO_SHOP}&timestamp=1700000000`;
    const hmac = crypto.createHmac("sha256", API_SECRET).update(sortedBase).digest("hex");
    expect(verifyShopifyHmac(`${rawOutOfOrder}&hmac=${hmac}`, API_SECRET)).toBe(true);
  });

  it("rejects a query carrying more than one hmac parameter", () => {
    // Shopify never sends two. Every "hmac=" pair is stripped from the signing base regardless of
    // count, so a query smuggling a bogus extra one alongside the genuine value must not be
    // accepted just because *some* pair happens to carry the right digest.
    const message = `shop=${DEMO_SHOP}`;
    const validHmac = crypto.createHmac("sha256", API_SECRET).update(message).digest("hex");
    expect(verifyShopifyHmac(`hmac=deadbeef&${message}&hmac=${validHmac}`, API_SECRET)).toBe(false);
  });

  it("rejects a digest that is a correct prefix of the real one, truncated by one character", () => {
    // Pins that the comparison checks the whole digest, not merely a prefix -- safeEqual already
    // rejects on a length mismatch, but nothing in this suite asserted that until now.
    const message = `shop=${DEMO_SHOP}`;
    const fullHmac = crypto.createHmac("sha256", API_SECRET).update(message).digest("hex");
    const truncatedHmac = fullHmac.slice(0, -1);
    expect(verifyShopifyHmac(`${message}&hmac=${truncatedHmac}`, API_SECRET)).toBe(false);
  });
});

describe("requireShopifyHmac", () => {
  function buildApp() {
    const app = express();
    app.get("/oauth/shopify-callback", requireShopifyHmac(API_SECRET), (_req, res) => {
      res.status(200).send("reached the controller");
    });
    return app;
  }

  it("passes a correctly signed request through", async () => {
    const response = await request(buildApp()).get(`/oauth/shopify-callback?${signQuery({ shop: DEMO_SHOP })}`);
    expect(response.status).toBe(200);
  });

  it("blocks an unsigned request with 400", async () => {
    const response = await request(buildApp()).get(`/oauth/shopify-callback?shop=${DEMO_SHOP}`);
    expect(response.status).toBe(400);
  });

  it("blocks a request whose parameter was tampered with after signing, with 400", async () => {
    const signed = signQuery({ shop: DEMO_SHOP, code: "abc" });
    const tampered = signed.replace("code=abc", "code=xyz");
    const response = await request(buildApp()).get(`/oauth/shopify-callback?${tampered}`);
    expect(response.status).toBe(400);
    expect(response.text).toBe("invalid hmac");
  });

  it("verifies against the raw query string Express received, not a rebuild from req.query", async () => {
    // This is the binding constraint of this whole module: the message must come from
    // req.originalUrl, never be reconstructed from req.query. A %20-encoded space is the vector
    // that exposes a rebuild -- Express decodes it to a literal space in req.query, and
    // re-serializing that (via URLSearchParams, querystring.stringify, or an object) turns it back
    // into "+", not "%20", producing a different base string and therefore a different digest. If
    // requireShopifyHmac is ever changed to source its queryString from req.query instead of
    // req.originalUrl, this test goes red even though every other test in this file -- whose
    // signed values never contain a character with more than one valid percent-encoding -- stays
    // green.
    const rawQueryWithoutHmac = `shop=${DEMO_SHOP}&state=a%20b`;
    const hmac = crypto.createHmac("sha256", API_SECRET).update(rawQueryWithoutHmac).digest("hex");
    const response = await request(buildApp()).get(`/oauth/shopify-callback?${rawQueryWithoutHmac}&hmac=${hmac}`);
    expect(response.status).toBe(200);
  });

  it("verifies a raw query whose signed value contains a literal '?' (legal per RFC 3986)", async () => {
    // RFC 3986's query component allows an unescaped "?" -- it's just another character of the
    // query, not a delimiter, and Express's own req.query is built from everything after the
    // *first* "?" regardless. Sourcing the signing base with String.prototype.split("?") instead
    // of slicing from the first occurrence would truncate at this literal "?", losing the hmac
    // param entirely and wrongly rejecting a legitimate callback.
    const rawQueryWithoutHmac = `shop=${DEMO_SHOP}&state=a?b`;
    const hmac = crypto.createHmac("sha256", API_SECRET).update(rawQueryWithoutHmac).digest("hex");
    const response = await request(buildApp()).get(`/oauth/shopify-callback?${rawQueryWithoutHmac}&hmac=${hmac}`);
    expect(response.status).toBe(200);
  });

  it("rejects a query with unsigned parameters appended after a second '?' in the URL", async () => {
    // The dangerous direction of the same gap: if requireShopifyHmac split on "?" instead of
    // slicing from the first occurrence, an attacker-appended "?&shop=evil.myshopify.com" would
    // sit entirely after the truncation point, so the signature would still verify against only
    // the genuine prefix -- while Express's own req.query (parsed from everything after the
    // *first* "?") would see a duplicated "shop" key this check never looked at.
    const legitimateMessage = `code=abc&shop=${DEMO_SHOP}`;
    const validHmac = crypto.createHmac("sha256", API_SECRET).update(legitimateMessage).digest("hex");
    const maliciousQuery = `${legitimateMessage}&hmac=${validHmac}?&shop=evil.myshopify.com`;
    const response = await request(buildApp()).get(`/oauth/shopify-callback?${maliciousQuery}`);
    expect(response.status).toBe(400);
  });
});
```

`src/controllers/shopifyCallback.test.ts`:

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig, type ResolvedConfig } from "../config";
import { consumeCode } from "../services/codes";
import { signOuterState } from "../services/stateJwt";
import type { Logger } from "../types";
import { shopifyCallbackController } from "./shopifyCallback";

const HOST = "https://mcp.example.com";
const STATE_SECRET = "test-state-secret-at-least-32-bytes-long";
const API_SECRET_CANARY = "test-api-secret";
const DEMO_SHOP = "demo.myshopify.com";
const DEMO_SHOP_ID = "shop_1";
const CLIENT_ID = "test-client-id";
const REDIRECT_URI = "https://client.example/callback";
const CLIENT_STATE = "client-state-value";
const CODE_CHALLENGE = "challenge-value";
const CODE_CHALLENGE_METHOD = "S256";
const RESOURCE = `${HOST}/mcp`;
const SHOPIFY_ACCESS_TOKEN = "shpua_exchanged_token";

// Only the "generic 500" tests need this -- they deliberately trigger asyncHandler's error log,
// and the default console logger would print a stack trace on every full-suite run otherwise.
const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function buildConfig(
  overrides: { installed?: boolean; fetchImpl?: typeof fetch; logger?: Logger } = {}
): ResolvedConfig {
  const installed = overrides.installed ?? true;
  const storage = memoryStorage({ shops: installed ? [{ id: DEMO_SHOP_ID, domain: DEMO_SHOP }] : [] });
  const fetchImpl =
    overrides.fetchImpl ??
    (vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: SHOPIFY_ACCESS_TOKEN }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ) as unknown as typeof fetch);

  return resolveConfig({
    host: HOST,
    shopify: { apiKey: "test-api-key", apiSecret: API_SECRET_CANARY, scopes: "read_products" },
    stateSecret: STATE_SECRET,
    storage,
    fetchImpl,
    logger: overrides.logger,
  });
}

function buildApp(config: ResolvedConfig) {
  const app = express();
  // The HMAC middleware is exercised separately; this suite covers the controller itself.
  app.get("/oauth/shopify-callback", shopifyCallbackController(config));
  return app;
}

// supertest/superagent types response.headers as a plain string-keyed record, so
// noUncheckedIndexedAccess widens response.headers.location to string | undefined even though a
// 302 always sets it -- every caller here already depends on that redirect having happened.
function redirectLocation(response: request.Response): string {
  return response.headers.location ?? "";
}

function buildState(overrides: Record<string, string> = {}): string {
  return signOuterState(
    {
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      clientState: CLIENT_STATE,
      codeChallenge: CODE_CHALLENGE,
      codeChallengeMethod: CODE_CHALLENGE_METHOD,
      resource: RESOURCE,
      nonce: "nonce-value",
      ...overrides,
    },
    STATE_SECRET,
    600
  );
}

describe("shopifyCallbackController", () => {
  it("redirects back to the client with a code and its original state", async () => {
    const response = await request(buildApp(buildConfig()))
      .get("/oauth/shopify-callback")
      .query({ shop: DEMO_SHOP, code: "shopify-code", state: buildState(), hmac: "checked-elsewhere" });

    expect(response.status).toBe(302);
    const location = new URL(redirectLocation(response));
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
    expect(location.searchParams.get("state")).toBe(CLIENT_STATE);
    expect(location.searchParams.get("code")).toBeTruthy();
  });

  it("binds the issued code to the shop and the client", async () => {
    const config = buildConfig();
    const response = await request(buildApp(config))
      .get("/oauth/shopify-callback")
      .query({ shop: DEMO_SHOP, code: "shopify-code", state: buildState(), hmac: "checked-elsewhere" });

    const code = new URL(redirectLocation(response)).searchParams.get("code") ?? "";
    // Every field carried over from the verified state, not just the shop/client identity: these
    // are exactly what /token (Task 17) will check against the PKCE verifier, the redirect_uri a
    // client presents, and the resource it asks for -- a drift here is invisible until then, so
    // pin all of it here, where it's written.
    expect(await consumeCode(config, code)).toMatchObject({
      shopId: DEMO_SHOP_ID,
      shopDomain: DEMO_SHOP,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeChallenge: CODE_CHALLENGE,
      codeChallengeMethod: CODE_CHALLENGE_METHOD,
      resource: RESOURCE,
    });
  });

  it("exchanges the Shopify code against the shop's own domain", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ access_token: SHOPIFY_ACCESS_TOKEN }), { status: 200 })
      ) as unknown as typeof fetch;
    await request(buildApp(buildConfig({ fetchImpl })))
      .get("/oauth/shopify-callback")
      .query({ shop: DEMO_SHOP, code: "shopify-code", state: buildState(), hmac: "checked-elsewhere" });

    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe(`https://${DEMO_SHOP}/admin/oauth/access_token`);
  });

  it("answers 403 when the shop is not installed", async () => {
    const response = await request(buildApp(buildConfig({ installed: false })))
      .get("/oauth/shopify-callback")
      .query({ shop: DEMO_SHOP, code: "shopify-code", state: buildState(), hmac: "checked-elsewhere" });

    expect(response.status).toBe(403);
    expect(response.text).toMatch(/install/i);
  });

  it("rejects a state signed with a different secret", async () => {
    const forged = signOuterState(
      {
        clientId: CLIENT_ID,
        redirectUri: "https://attacker.example/callback",
        clientState: CLIENT_STATE,
        codeChallenge: CODE_CHALLENGE,
        codeChallengeMethod: CODE_CHALLENGE_METHOD,
        resource: RESOURCE,
        nonce: "nonce-value",
      },
      "an-entirely-different-state-secret",
      600
    );
    const response = await request(buildApp(buildConfig()))
      .get("/oauth/shopify-callback")
      .query({ shop: DEMO_SHOP, code: "shopify-code", state: forged, hmac: "checked-elsewhere" });

    expect(response.status).toBe(400);
  });

  it("rejects a shop domain outside myshopify.com", async () => {
    const response = await request(buildApp(buildConfig()))
      .get("/oauth/shopify-callback")
      .query({ shop: "attacker.example.com", code: "shopify-code", state: buildState(), hmac: "checked-elsewhere" });

    expect(response.status).toBe(400);
  });

  it("fails when Shopify's exchange returns no access token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    const response = await request(buildApp(buildConfig({ fetchImpl })))
      .get("/oauth/shopify-callback")
      .query({ shop: DEMO_SHOP, code: "shopify-code", state: buildState(), hmac: "checked-elsewhere" });

    expect(response.status).toBe(400);
  });

  it("fails when Shopify's exchange returns an error status", async () => {
    // The body is valid JSON carrying a real access_token, on purpose: this pins the exchange.ok
    // gate itself, not the access-token gate below it. The previous fixture's body ("nope") wasn't
    // valid JSON, so exchange.json() threw and the *access-token* check produced this test's 400
    // -- deleting the exchange.ok check entirely left the whole suite green. With a parseable body
    // that would otherwise satisfy every check downstream, only exchange.ok can still fail this.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ access_token: SHOPIFY_ACCESS_TOKEN }), { status: 401 })
      ) as unknown as typeof fetch;
    const response = await request(buildApp(buildConfig({ fetchImpl })))
      .get("/oauth/shopify-callback")
      .query({ shop: DEMO_SHOP, code: "shopify-code", state: buildState(), hmac: "checked-elsewhere" });

    expect(response.status).toBe(400);
  });

  it("classifies a network-level exchange failure as 400 with fixed text, never the raw error", async () => {
    // A connection-refused-style rejection from fetchImpl itself (not a Shopify response) is
    // server-side detail about how *we* tried to reach Shopify, not a judgment about the
    // merchant's request -- it must not ride the caught error's .message into the response body,
    // the same leak that cost the CIMD resolver (services/cimd.ts) a fixed-text rule of its own.
    const canaryMessage = "connect ECONNREFUSED 10.1.2.3:443";
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError(canaryMessage)) as unknown as typeof fetch;
    const response = await request(buildApp(buildConfig({ fetchImpl })))
      .get("/oauth/shopify-callback")
      .query({ shop: DEMO_SHOP, code: "shopify-code", state: buildState(), hmac: "checked-elsewhere" });

    expect(response.status).toBe(400);
    expect(response.text).not.toContain(canaryMessage);
    expect(response.text).not.toContain("10.1.2.3");
  });

  it("returns a generic 500 without leaking internal detail when the shop lookup fails", async () => {
    // findShopByDomain is our own storage, not a statement about the merchant's request -- an
    // outage there must propagate as an ordinary Error and reach asyncHandler's generic 500,
    // never be reflected into a 4xx body.
    const config = buildConfig({ logger: silentLogger });
    vi.spyOn(config.storage, "findShopByDomain").mockRejectedValue(
      new Error("storage unavailable: connection to db.internal.example refused")
    );
    const response = await request(buildApp(config))
      .get("/oauth/shopify-callback")
      .query({ shop: DEMO_SHOP, code: "shopify-code", state: buildState(), hmac: "checked-elsewhere" });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "server_error", error_description: "An unexpected error occurred" });
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain("db.internal.example");
    expect(raw).not.toContain(API_SECRET_CANARY);
    expect(raw).not.toContain(STATE_SECRET);
  });

  it("returns a generic 500 without leaking internal detail when issuing the code fails", async () => {
    // issueCode's cache write is our own infrastructure too (see services/codes.ts); a failure
    // there is symmetric with the storage case above and must land on the same generic 500 path.
    const config = buildConfig({ logger: silentLogger });
    vi.spyOn(config.cache, "set").mockRejectedValue(new Error("cache unavailable: redis.internal.example timed out"));
    const response = await request(buildApp(config))
      .get("/oauth/shopify-callback")
      .query({ shop: DEMO_SHOP, code: "shopify-code", state: buildState(), hmac: "checked-elsewhere" });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "server_error", error_description: "An unexpected error occurred" });
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain("redis.internal.example");
    expect(raw).not.toContain(API_SECRET_CANARY);
    expect(raw).not.toContain(STATE_SECRET);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter shopify-mcp-oauth test src/middlewares/verifyShopifyHmac.test.ts src/controllers/shopifyCallback.test.ts`
Expected: FAIL — neither module resolves.

- [ ] **Step 3: Write `src/middlewares/verifyShopifyHmac.ts`**

```ts
import crypto from "node:crypto";
import type { RequestHandler } from "express";
import { safeEqual } from "../crypto";

// Shopify signs the raw, URL-encoded query string it sent. Rebuilding the message from decoded
// values (req.query) re-encodes reserved characters differently and produces a mismatched base
// string, so this always works from the raw string Express received (req.originalUrl), never
// from req.query.
//
// The remaining parameters are sorted by key before hashing. Shopify's docs state this
// explicitly for the *installation-request* HMAC ("the remaining parameters must be sorted
// alphabetically as strings, in the format parameter_name=parameter_value") but this module
// verifies the *OAuth callback* HMAC, a different request whose own doc section only says "the
// hmac is valid and signed by Shopify" and defers to a library -- it doesn't restate an
// algorithm. Shopify's own shopify-api-js library uses one shared, always-sorted code path for
// both requests, and there's no separate order-preserving scheme documented or implemented
// anywhere, so this reads the callback's terse wording as shorthand for the installation
// request's algorithm, not an unspecified alternative -- and sorts here too. For this endpoint's
// fixed field set (code, hmac, host, shop, state, timestamp), Shopify's actual send order already
// is alphabetical, so this has no effect on real traffic today -- but that's a property of this
// field set, not something documented, so don't rely on it: sort explicitly rather than trust
// received order to keep coinciding as fields change.
function pairKey(pair: string): string {
  const separatorIndex = pair.indexOf("=");
  return separatorIndex === -1 ? pair : pair.slice(0, separatorIndex);
}

export function verifyShopifyHmac(queryString: string, secret: string): boolean {
  const pairs = queryString.split("&").filter(Boolean);
  let provided: string | undefined;
  let hmacPairCount = 0;
  const rest: string[] = [];
  for (const pair of pairs) {
    if (pair.startsWith("hmac=")) {
      hmacPairCount += 1;
      try {
        provided = decodeURIComponent(pair.slice("hmac=".length));
      } catch {
        // A malformed percent-encoding in the hmac param can't be a digest Shopify produced;
        // fail closed rather than letting decodeURIComponent's throw escape this function.
        return false;
      }
    } else {
      rest.push(pair);
    }
  }
  // Shopify never sends more than one hmac parameter. Every "hmac=" pair is stripped from the
  // signing base regardless of how many there are, so a query smuggling a second one would
  // otherwise still hash correctly as long as *some* pair happens to carry the genuine value --
  // reject outright instead of silently picking one (the loop above keeps the last).
  if (hmacPairCount !== 1 || !provided) return false;

  // Sort by key, not by the whole "key=value" string: the documented algorithm sorts
  // parameters, and sorting whole pairs only coincidentally agrees once values differ in ways
  // that could shift the comparison. The key is sliced off with indexOf("=") -- never decoded --
  // so the sort itself never re-encodes a byte of what it's ordering. A plain code-unit
  // comparison, not localeCompare: localeCompare's result depends on the host's ICU/locale data,
  // which has no business affecting a signature check that must agree byte-for-byte with a
  // remote party. For Shopify's ASCII parameter names the two agree, so this is strictly safer
  // with no behavioral downside. Array.prototype.sort is spec-guaranteed stable, so pairs sharing
  // a key keep their received relative order.
  const sorted = [...rest].sort((left, right) => {
    const leftKey = pairKey(left);
    const rightKey = pairKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

  const computed = crypto.createHmac("sha256", secret).update(sorted.join("&")).digest("hex");
  return safeEqual(provided, computed);
}

export function requireShopifyHmac(secret: string): RequestHandler {
  return (req, res, next) => {
    // req.originalUrl can legally contain more than one "?": RFC 3986's query component allows
    // an unescaped "?", so a signed value like state=a?b puts a second "?" in the URL that isn't
    // a delimiter. String.prototype.split("?") doesn't know that -- it splits on *every* "?", and
    // [1] only ever returns the segment between the first and second one. That's wrong in both
    // directions: it truncates (and so rejects) a legitimate callback whose value contains "?",
    // and it lets an attacker append unsigned parameters after an injected second "?" that this
    // check then never sees, even though Express's own req.query -- built from everything after
    // the *first* "?" -- parses them anyway. Slicing from the first occurrence is the only way to
    // recover the exact same query string Express itself parses.
    const separatorIndex = req.originalUrl.indexOf("?");
    const queryString = separatorIndex === -1 ? "" : req.originalUrl.slice(separatorIndex + 1);
    if (!verifyShopifyHmac(queryString, secret)) {
      res.status(400).type("text/plain").send("invalid hmac");
      return;
    }
    next();
  };
}
```

- [ ] **Step 4: Write `src/controllers/shopifyCallback.ts`**

```ts
import type { RequestHandler } from "express";
import type { ResolvedConfig } from "../config";
import { shopifyCallbackQuerySchema } from "../schemas/shopifyCallback";
import { issueCode } from "../services/codes";
import { verifyOuterState, type VerifiedOuterState } from "../services/stateJwt";
import { asyncHandler } from "./asyncHandler";

export function shopifyCallbackController(config: ResolvedConfig): RequestHandler {
  return asyncHandler(config.logger, async (req, res) => {
    const parsed = shopifyCallbackQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .type("text/plain")
        .send(parsed.error.issues[0]?.message ?? "invalid query");
      return;
    }
    const query = parsed.data;

    let state: VerifiedOuterState;
    try {
      state = verifyOuterState(query.state, config.stateSecret);
    } catch {
      res.status(400).type("text/plain").send("invalid or expired state");
      return;
    }

    let exchange: Response;
    try {
      exchange = await config.fetchImpl(`https://${query.shop}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: config.shopify.apiKey,
          client_secret: config.shopify.apiSecret,
          code: query.code,
        }),
      });
    } catch {
      // Fixed text, not the caught error's message: a raw network error can carry connection-
      // level detail about how *we* tried to reach Shopify, not a judgment about the merchant's
      // own request. Classifying it as a 400 here still matches how resolveCimdClient treats its
      // own fetch failures (see services/cimd.ts) -- "we couldn't complete the exchange" is as
      // safe to say as any of the checks below.
      res.status(400).type("text/plain").send("shopify token exchange could not be completed");
      return;
    }
    if (!exchange.ok) {
      res.status(400).type("text/plain").send(`shopify exchange returned ${exchange.status}`);
      return;
    }

    let accessToken: string | undefined;
    try {
      accessToken = ((await exchange.json()) as { access_token?: string }).access_token;
    } catch {
      accessToken = undefined;
    }
    // The token is only ever proof that this merchant controls this shop. We do not keep it.
    if (!accessToken) {
      res.status(400).type("text/plain").send("shopify exchange returned no access token");
      return;
    }

    const shop = await config.storage.findShopByDomain(query.shop);
    if (!shop) {
      // Shopify installs the app on approval, so reaching this point does not prove the shop was
      // ever a customer. This lookup is the only install gate.
      res
        .status(403)
        .type("text/plain")
        .send(`${query.shop} has not installed this app. Install it first, then connect again.`);
      return;
    }

    const { code } = await issueCode(config, {
      shopId: shop.id,
      shopDomain: shop.domain,
      clientId: state.clientId,
      redirectUri: state.redirectUri,
      codeChallenge: state.codeChallenge,
      codeChallengeMethod: state.codeChallengeMethod,
      resource: state.resource,
    });

    const target = new URL(state.redirectUri);
    target.searchParams.set("code", code);
    target.searchParams.set("state", state.clientState);
    res.redirect(target.toString());
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter shopify-mcp-oauth test src/middlewares/verifyShopifyHmac.test.ts src/controllers/shopifyCallback.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/shopify-mcp-oauth/src/middlewares/verifyShopifyHmac.ts packages/shopify-mcp-oauth/src/middlewares/verifyShopifyHmac.test.ts packages/shopify-mcp-oauth/src/controllers/shopifyCallback.ts packages/shopify-mcp-oauth/src/controllers/shopifyCallback.test.ts
git commit -m "feat: verify Shopify's HMAC and issue codes from the callback"
```

---

## Task 17: Token controller

**Files:**
- Create: `packages/shopify-mcp-oauth/src/controllers/token.ts`
- Test: `packages/shopify-mcp-oauth/src/controllers/token.test.ts`

**Interfaces:**
- Consumes: `ResolvedConfig`; `tokenRequestSchema`, `AuthorizationCodeGrant`, `RefreshTokenGrant`; `verifyS256`; `consumeCode`, `issueCode`; `issueTokens`, `rotateRefresh`; `serializeTokenBundle`
- Produces: `tokenController(config: ResolvedConfig): RequestHandler`

The authorization-code grant re-checks everything the code was bound to: the client, the redirect URI,
and the PKCE challenge. The code is consumed before any of those checks, so a failed attempt still
burns it — a wrong verifier does not get to try again.

- [ ] **Step 1: Write the failing test**

`src/controllers/token.test.ts`:

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig, type ResolvedConfig } from "../config";
import { sha256Base64Url } from "../crypto";
import { issueCode } from "../services/codes";
import { issueTokens } from "../services/tokens";
import { tokenController } from "./token";

const HOST = "https://mcp.example.com";
const DEMO_SHOP = "demo.myshopify.com";
const DEMO_SHOP_ID = "shop_1";
const CLIENT_ID = "test-client-id";
const REDIRECT_URI = "https://client.example/callback";
const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

function buildConfig(): ResolvedConfig {
  return resolveConfig({
    host: HOST,
    shopify: { apiKey: "test-api-key", apiSecret: "test-api-secret", scopes: "read_products" },
    stateSecret: "test-state-secret-at-least-32-bytes-long",
    storage: memoryStorage({ shops: [{ id: DEMO_SHOP_ID, domain: DEMO_SHOP }] }),
  });
}

function buildApp(config: ResolvedConfig) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.post("/token", tokenController(config));
  return app;
}

async function issueTestCode(config: ResolvedConfig): Promise<string> {
  const { code } = await issueCode(config, {
    shopId: DEMO_SHOP_ID,
    shopDomain: DEMO_SHOP,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    codeChallenge: sha256Base64Url(CODE_VERIFIER),
    codeChallengeMethod: "S256",
    resource: `${HOST}/mcp`,
  });
  return code;
}

describe("tokenController — authorization_code", () => {
  it("exchanges a valid code for a token bundle", async () => {
    const config = buildConfig();
    const response = await request(buildApp(config)).post("/token").send({
      grant_type: "authorization_code",
      code: await issueTestCode(config),
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: CODE_VERIFIER,
    });

    expect(response.status).toBe(200);
    expect(response.body.token_type).toBe("Bearer");
    expect(response.body.access_token).toBeTruthy();
    expect(response.body.refresh_token).toBeTruthy();
    expect(response.body.expires_in).toBe(3600);
  });

  it("rejects a wrong PKCE verifier", async () => {
    const config = buildConfig();
    const response = await request(buildApp(config)).post("/token").send({
      grant_type: "authorization_code",
      code: await issueTestCode(config),
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: "not-the-verifier-that-made-the-challenge",
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_grant");
  });

  it("rejects a code presented by a different client", async () => {
    const config = buildConfig();
    const response = await request(buildApp(config)).post("/token").send({
      grant_type: "authorization_code",
      code: await issueTestCode(config),
      redirect_uri: REDIRECT_URI,
      client_id: "some-other-client",
      code_verifier: CODE_VERIFIER,
    });

    expect(response.status).toBe(400);
  });

  it("rejects a mismatched redirect_uri", async () => {
    const config = buildConfig();
    const response = await request(buildApp(config)).post("/token").send({
      grant_type: "authorization_code",
      code: await issueTestCode(config),
      redirect_uri: "https://attacker.example/callback",
      client_id: CLIENT_ID,
      code_verifier: CODE_VERIFIER,
    });

    expect(response.status).toBe(400);
  });

  it("refuses to redeem the same code twice", async () => {
    const config = buildConfig();
    const app = buildApp(config);
    const code = await issueTestCode(config);
    const body = {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: CODE_VERIFIER,
    };

    await request(app).post("/token").send(body);
    const second = await request(app).post("/token").send(body);
    expect(second.status).toBe(400);
  });

  it("accepts a form-encoded body, which is what most clients send", async () => {
    const config = buildConfig();
    const response = await request(buildApp(config))
      .post("/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code: await issueTestCode(config),
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: CODE_VERIFIER,
      });

    expect(response.status).toBe(200);
  });
});

describe("tokenController — refresh_token", () => {
  it("rotates a valid refresh token", async () => {
    const config = buildConfig();
    const first = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    const response = await request(buildApp(config))
      .post("/token")
      .send({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLIENT_ID });

    expect(response.status).toBe(200);
    expect(response.body.refresh_token).not.toBe(first.refresh_token);
  });

  it("rejects a refresh token that was already rotated", async () => {
    const config = buildConfig();
    const app = buildApp(config);
    const first = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    const body = { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLIENT_ID };

    await request(app).post("/token").send(body);
    const second = await request(app).post("/token").send(body);
    expect(second.status).toBe(400);
  });
});

describe("tokenController — bad requests", () => {
  it("reports unsupported_grant_type for an unknown grant", async () => {
    const response = await request(buildApp(buildConfig()))
      .post("/token")
      .send({ grant_type: "password", username: "merchant" });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("unsupported_grant_type");
  });

  it("reports invalid_request when a known grant is missing a field", async () => {
    const response = await request(buildApp(buildConfig()))
      .post("/token")
      .send({ grant_type: "authorization_code", code: "the-code" });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_request");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter shopify-mcp-oauth test src/controllers/token.test.ts`
Expected: FAIL — cannot resolve `./token`.

- [ ] **Step 3: Write `src/controllers/token.ts`**

```ts
import type { RequestHandler, Response } from "express";
import type { ResolvedConfig } from "../config";
import { tokenRequestSchema, type AuthorizationCodeGrant, type RefreshTokenGrant } from "../schemas/token";
import { serializeTokenBundle } from "../serializers/token";
import { consumeCode } from "../services/codes";
import { verifyS256 } from "../services/pkce";
import { issueTokens, rotateRefresh } from "../services/tokens";
import { asyncHandler } from "./asyncHandler";

function bad(res: Response, code: string, description: string): void {
  res.status(400).json({ error: code, error_description: description });
}

async function handleAuthorizationCode(
  config: ResolvedConfig,
  grant: AuthorizationCodeGrant,
  res: Response
): Promise<void> {
  // Consumed first: a failed attempt still burns the code, so a wrong verifier gets no retry.
  const record = await consumeCode(config, grant.code);
  if (!record) return bad(res, "invalid_grant", "code unknown, expired, or already used");
  if (record.clientId !== grant.client_id) return bad(res, "invalid_grant", "client_id mismatch");
  if (record.redirectUri !== grant.redirect_uri) return bad(res, "invalid_grant", "redirect_uri mismatch");
  if (!verifyS256(grant.code_verifier, record.codeChallenge)) {
    return bad(res, "invalid_grant", "PKCE verifier failed");
  }

  const tokens = await issueTokens(config, {
    shopId: record.shopId,
    shopDomain: record.shopDomain,
    clientId: record.clientId,
    resource: record.resource,
  });
  res.status(200).json(serializeTokenBundle(tokens));
}

async function handleRefreshToken(
  config: ResolvedConfig,
  grant: RefreshTokenGrant,
  res: Response
): Promise<void> {
  const rotated = await rotateRefresh(config, grant.refresh_token, grant.client_id);
  if (!rotated) return bad(res, "invalid_grant", "refresh_token unknown, expired, or already rotated");
  res.status(200).json(serializeTokenBundle(rotated));
}

export function tokenController(config: ResolvedConfig): RequestHandler {
  return asyncHandler(config.logger, async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object") return bad(res, "invalid_request", "body required");

    const parsed = tokenRequestSchema.safeParse(body);
    if (!parsed.success) {
      const grantType = (body as Record<string, unknown>).grant_type;
      const known = grantType === "authorization_code" || grantType === "refresh_token";
      if (!known) {
        return bad(res, "unsupported_grant_type", `grant_type ${String(grantType ?? "(none)")} not supported`);
      }
      return bad(res, "invalid_request", parsed.error.issues[0]?.message ?? "invalid request");
    }

    if (parsed.data.grant_type === "authorization_code") {
      return handleAuthorizationCode(config, parsed.data, res);
    }
    return handleRefreshToken(config, parsed.data, res);
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter shopify-mcp-oauth test src/controllers/token.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shopify-mcp-oauth/src/controllers/token.ts packages/shopify-mcp-oauth/src/controllers/token.test.ts
git commit -m "feat: add /token with PKCE verification and refresh rotation"
```

---

## Task 18: requireAuth middleware

**Files:**
- Create: `packages/shopify-mcp-oauth/src/middlewares/requireAuth.ts`
- Test: `packages/shopify-mcp-oauth/src/middlewares/requireAuth.test.ts`

**Interfaces:**
- Consumes: `ResolvedConfig`; `sha256Hex`; `McpAuthContext` from `../types`
- Produces:
  - `requireAuth(config: ResolvedConfig): RequestHandler`
  - `declare module "express-serve-static-core" { interface Request { mcp?: McpAuthContext } }`

This is the Resource Server half. Every 401 carries an RFC 9728 `WWW-Authenticate` header naming the
protected-resource metadata document — that header is how a client discovers where to start the login
flow, so omitting it strands clients that have never seen the server before.

- [ ] **Step 1: Write the failing test**

`src/middlewares/requireAuth.test.ts`:

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig, type ResolvedConfig } from "../config";
import { sha256Hex } from "../crypto";
import { issueTokens } from "../services/tokens";
import { requireAuth } from "./requireAuth";

const HOST = "https://mcp.example.com";
const DEMO_SHOP = "demo.myshopify.com";
const DEMO_SHOP_ID = "shop_1";
const CLIENT_ID = "test-client-id";

function buildConfig(): ResolvedConfig {
  return resolveConfig({
    host: HOST,
    shopify: { apiKey: "test-api-key", apiSecret: "test-api-secret", scopes: "read_products" },
    stateSecret: "test-state-secret-at-least-32-bytes-long",
    storage: memoryStorage({ shops: [{ id: DEMO_SHOP_ID, domain: DEMO_SHOP }] }),
  });
}

function buildApp(config: ResolvedConfig) {
  const app = express();
  app.use(express.json());
  app.post("/mcp", requireAuth(config), (req, res) => {
    res.status(200).json(req.mcp);
  });
  return app;
}

describe("requireAuth", () => {
  it("passes a live token through and exposes the shop", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    const response = await request(buildApp(config))
      .post("/mcp")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.shopDomain).toBe(DEMO_SHOP);
    expect(response.body.shopId).toBe(DEMO_SHOP_ID);
  });

  it("rejects a request with no Authorization header", async () => {
    const response = await request(buildApp(buildConfig())).post("/mcp").send({});
    expect(response.status).toBe(401);
  });

  it("rejects a non-Bearer scheme", async () => {
    const response = await request(buildApp(buildConfig()))
      .post("/mcp")
      .set("Authorization", "Basic dXNlcjpwYXNz")
      .send({});
    expect(response.status).toBe(401);
  });

  it("rejects an unknown token", async () => {
    const response = await request(buildApp(buildConfig()))
      .post("/mcp")
      .set("Authorization", "Bearer never-issued")
      .send({});
    expect(response.status).toBe(401);
  });

  it("rejects a revoked token", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, { shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, clientId: CLIENT_ID });
    const stored = await config.storage.findTokenByRefreshHash(sha256Hex(tokens.refresh_token));
    await config.storage.revokeToken(stored!.id);

    const response = await request(buildApp(config))
      .post("/mcp")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({});
    expect(response.status).toBe(401);
  });

  it("points a 401 at the protected-resource metadata document", async () => {
    const response = await request(buildApp(buildConfig())).post("/mcp").send({});
    expect(response.headers["www-authenticate"]).toContain(`${HOST}/.well-known/oauth-protected-resource`);
  });

  it("rejects a token whose shop has since been uninstalled", async () => {
    const config = buildConfig();
    const tokens = await issueTokens(config, {
      shopId: "shop_gone",
      shopDomain: "uninstalled.myshopify.com",
      clientId: CLIENT_ID,
    });
    const response = await request(buildApp(config))
      .post("/mcp")
      .set("Authorization", `Bearer ${tokens.access_token}`)
      .send({});
    expect(response.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter shopify-mcp-oauth test src/middlewares/requireAuth.test.ts`
Expected: FAIL — cannot resolve `./requireAuth`.

- [ ] **Step 3: Write `src/middlewares/requireAuth.ts`**

```ts
import type { RequestHandler } from "express";
import type { ResolvedConfig } from "../config";
import { sha256Hex } from "../crypto";
import type { McpAuthContext } from "../types";

declare module "express-serve-static-core" {
  interface Request {
    mcp?: McpAuthContext;
  }
}

export function requireAuth(config: ResolvedConfig): RequestHandler {
  const resourceMetadata = `${config.host}/.well-known/oauth-protected-resource`;

  return async (req, res, next) => {
    // RFC 9728: the header is how a client that has never seen this server discovers where to
    // begin the login flow. Every 401 carries it.
    function unauthorized(error: string): void {
      res.setHeader("WWW-Authenticate", `Bearer error="${error}", resource_metadata="${resourceMetadata}"`);
      res.status(401).json({ error });
    }

    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return unauthorized("missing_bearer");
    }

    const token = header.slice("Bearer ".length).trim();
    const stored = await config.storage.findTokenByAccessHash(sha256Hex(token));
    if (!stored) return unauthorized("invalid_token");

    // A token outlives an uninstall, so confirm the shop is still known on every request.
    const shop = await config.storage.findShopByDomain(stored.shopDomain);
    if (!shop) return unauthorized("invalid_token");

    req.mcp = { shopId: stored.shopId, shopDomain: stored.shopDomain, tokenId: stored.id };
    config.storage.touchToken(stored.id, new Date()).catch(() => {});
    next();
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter shopify-mcp-oauth test src/middlewares/requireAuth.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shopify-mcp-oauth/src/middlewares/requireAuth.ts packages/shopify-mcp-oauth/src/middlewares/requireAuth.test.ts
git commit -m "feat: add the resource-server bearer middleware"
```

---

## Task 19: Rate limiting

**Files:**
- Create: `packages/shopify-mcp-oauth/src/middlewares/rateLimit.ts`
- Test: `packages/shopify-mcp-oauth/src/middlewares/rateLimit.test.ts`

**Interfaces:**
- Consumes: nothing beyond Express types
- Produces: `createRateLimiter(opts: { limit: number; windowMs: number; keyFor?: (req: Request) => string }): RequestHandler`

A fixed-window counter in process memory, deliberately dependency-free. `/register` is
unauthenticated by definition, which makes it the one endpoint anyone on the internet can write to.

The limiter is per-process, so a multi-instance deployment multiplies the effective limit by the
instance count. That is acceptable for a spam brake and is documented rather than engineered around.

- [ ] **Step 1: Write the failing test**

`src/middlewares/rateLimit.test.ts`:

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rateLimit";

function buildApp(limit: number, windowMs: number) {
  const app = express();
  app.post("/register", createRateLimiter({ limit, windowMs }), (_req, res) => {
    res.status(201).json({ ok: true });
  });
  return app;
}

describe("createRateLimiter", () => {
  it("allows requests up to the limit", async () => {
    const app = buildApp(2, 60_000);
    expect((await request(app).post("/register")).status).toBe(201);
    expect((await request(app).post("/register")).status).toBe(201);
  });

  it("answers 429 once the limit is exceeded", async () => {
    const app = buildApp(1, 60_000);
    await request(app).post("/register");
    const blocked = await request(app).post("/register");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("too_many_requests");
  });

  it("sets Retry-After on a blocked response", async () => {
    const app = buildApp(1, 60_000);
    await request(app).post("/register");
    const blocked = await request(app).post("/register");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("allows again once the window has passed", async () => {
    const app = buildApp(1, 1);
    await request(app).post("/register");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await request(app).post("/register")).status).toBe(201);
  });

  it("counts each key separately", async () => {
    const app = express();
    app.post(
      "/register",
      createRateLimiter({ limit: 1, windowMs: 60_000, keyFor: (req) => String(req.headers["x-test-key"]) }),
      (_req, res) => res.status(201).json({ ok: true })
    );

    expect((await request(app).post("/register").set("x-test-key", "first")).status).toBe(201);
    expect((await request(app).post("/register").set("x-test-key", "second")).status).toBe(201);
    expect((await request(app).post("/register").set("x-test-key", "first")).status).toBe(429);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter shopify-mcp-oauth test src/middlewares/rateLimit.test.ts`
Expected: FAIL — cannot resolve `./rateLimit`.

- [ ] **Step 3: Write `src/middlewares/rateLimit.ts`**

```ts
import type { Request, RequestHandler } from "express";

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  keyFor?: (req: Request) => string;
}

function defaultKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

// Fixed-window counter held in process memory. On a multi-instance deployment the effective
// limit multiplies by the instance count; that is acceptable for a spam brake.
export function createRateLimiter(options: RateLimiterOptions): RequestHandler {
  const windows = new Map<string, Window>();
  const keyFor = options.keyFor ?? defaultKey;

  return (req, res, next) => {
    const key = keyFor(req);
    const now = Date.now();
    const current = windows.get(key);

    if (!current || current.resetAt <= now) {
      windows.set(key, { count: 1, resetAt: now + options.windowMs });
      return next();
    }

    if (current.count >= options.limit) {
      res.setHeader("Retry-After", Math.max(1, Math.ceil((current.resetAt - now) / 1000)));
      res.status(429).json({ error: "too_many_requests", error_description: "rate limit exceeded" });
      return;
    }

    current.count += 1;
    next();
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter shopify-mcp-oauth test src/middlewares/rateLimit.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shopify-mcp-oauth/src/middlewares/rateLimit.ts packages/shopify-mcp-oauth/src/middlewares/rateLimit.test.ts
git commit -m "feat: add a fixed-window rate limiter for the registration endpoint"
```

---

## Task 20: Router, factory, and public exports

**Files:**
- Create: `packages/shopify-mcp-oauth/src/router.ts`
- Modify: `packages/shopify-mcp-oauth/src/index.ts` (replace the `PACKAGE_NAME` placeholder from Task 1)
- Modify: `packages/shopify-mcp-oauth/src/index.test.ts` (replace the placeholder test)
- Test: `packages/shopify-mcp-oauth/src/router.test.ts`

**Interfaces:**
- Consumes: every controller and middleware from Tasks 14–19; `resolveConfig` from `./config`
- Produces:
  - `buildRouter(config: ResolvedConfig, options?: BuildRouterOptions): Router`
  - `createShopifyMcpOAuth(config: ShopifyMcpOAuthConfig, options?: BuildRouterOptions): ShopifyMcpOAuth`
  - the package's full public export surface

The six discovery routes are deliberate duplication. Clients probe different URLs, and a 404 on the
one a given client happens to check surfaces to the user as "this server does not support OAuth".

- [ ] **Step 1: Write the failing test**

`src/router.test.ts`:

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { memoryStorage } from "./adapters/memoryStorage";
import { createShopifyMcpOAuth } from "./index";

const HOST = "https://mcp.example.com";
const DEMO_SHOP = "demo.myshopify.com";
const DEMO_SHOP_ID = "shop_1";
const REDIRECT_URI = "https://client.example/callback";

function buildApp() {
  const oauth = createShopifyMcpOAuth({
    host: HOST,
    shopify: { apiKey: "test-api-key", apiSecret: "test-api-secret", scopes: "read_products" },
    stateSecret: "test-state-secret-at-least-32-bytes-long",
    storage: memoryStorage({ shops: [{ id: DEMO_SHOP_ID, domain: DEMO_SHOP }] }),
  });
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(oauth.router);
  app.post("/mcp", oauth.requireAuth, (req, res) => res.status(200).json(req.mcp));
  return app;
}

const DISCOVERY_PATHS = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/mcp",
  "/.well-known/openid-configuration",
  "/.well-known/openid-configuration/mcp",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
];

describe("router", () => {
  it.each(DISCOVERY_PATHS)("serves %s", async (path) => {
    const response = await request(buildApp()).get(path);
    expect(response.status).toBe(200);
  });

  it("mounts /register", async () => {
    const response = await request(buildApp()).post("/register").send({ redirect_uris: [REDIRECT_URI] });
    expect(response.status).toBe(201);
  });

  it("mounts /token", async () => {
    const response = await request(buildApp()).post("/token").send({ grant_type: "password" });
    expect(response.body.error).toBe("unsupported_grant_type");
  });

  it("mounts /revoke", async () => {
    const response = await request(buildApp()).post("/revoke").send({ token: "never-issued" });
    expect(response.status).toBe(200);
  });

  it("mounts /authorize", async () => {
    const response = await request(buildApp()).get("/authorize");
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_request");
  });

  it("guards the mcp route with requireAuth", async () => {
    const response = await request(buildApp()).post("/mcp").send({});
    expect(response.status).toBe(401);
  });

  it("omits the openai challenge route when no token is configured", async () => {
    const response = await request(buildApp()).get("/.well-known/openai-apps-challenge");
    expect(response.status).toBe(404);
  });
});

describe("createShopifyMcpOAuth", () => {
  it("throws on an invalid host before any request is served", () => {
    expect(() =>
      createShopifyMcpOAuth({
        host: "mcp.example.com",
        shopify: { apiKey: "test-api-key", apiSecret: "test-api-secret", scopes: "read_products" },
        stateSecret: "test-state-secret-at-least-32-bytes-long",
        storage: memoryStorage(),
      })
    ).toThrow(/host/);
  });
});
```

Delete the placeholder test file from Task 1:

```bash
rm packages/shopify-mcp-oauth/src/index.test.ts
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter shopify-mcp-oauth test src/router.test.ts`
Expected: FAIL — `createShopifyMcpOAuth` is not exported from `./index`.

- [ ] **Step 3: Write `src/router.ts`**

```ts
import { Router } from "express";
import type { ResolvedConfig } from "./config";
import { authorizeController } from "./controllers/authorize";
import {
  authorizationServerMetadataController,
  protectedResourceMetadataController,
} from "./controllers/metadata";
import { openaiAppsChallengeController } from "./controllers/openaiAppsChallenge";
import { registerController } from "./controllers/register";
import { revokeController } from "./controllers/revoke";
import { shopifyCallbackController } from "./controllers/shopifyCallback";
import { tokenController } from "./controllers/token";
import { createRateLimiter } from "./middlewares/rateLimit";
import { requireShopifyHmac } from "./middlewares/verifyShopifyHmac";

export interface BuildRouterOptions {
  allowPrivateCimdHosts?: boolean;
}

export function buildRouter(config: ResolvedConfig, options: BuildRouterOptions = {}): Router {
  const router = Router();

  const authorizationServer = authorizationServerMetadataController(config);
  const protectedResource = protectedResourceMetadataController(config);

  // Clients probe different discovery URLs; a 404 on the one a given client checks reads to the
  // user as "this server does not support OAuth".
  router.get("/.well-known/oauth-authorization-server", authorizationServer);
  router.get("/.well-known/oauth-authorization-server/mcp", authorizationServer);
  router.get("/.well-known/openid-configuration", authorizationServer);
  router.get("/.well-known/openid-configuration/mcp", authorizationServer);
  router.get("/.well-known/oauth-protected-resource", protectedResource);
  router.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  if (config.openaiAppsChallengeToken) {
    router.get("/.well-known/openai-apps-challenge", openaiAppsChallengeController(config.openaiAppsChallengeToken));
  }

  router.post(
    "/register",
    createRateLimiter({ limit: config.registerRateLimit.limit, windowMs: config.registerRateLimit.windowMs }),
    registerController(config)
  );

  router.get("/authorize", authorizeController(config, { allowPrivateCimdHosts: options.allowPrivateCimdHosts }));
  router.get(
    "/oauth/shopify-callback",
    requireShopifyHmac(config.shopify.apiSecret),
    shopifyCallbackController(config)
  );
  router.post("/token", tokenController(config));
  router.post("/revoke", revokeController(config));

  return router;
}
```

- [ ] **Step 4: Rewrite `src/index.ts` with the full export surface**

```ts
import type { RequestHandler, Router } from "express";
import { resolveConfig, type ShopifyMcpOAuthConfig } from "./config";
import { requireAuth } from "./middlewares/requireAuth";
import { buildRouter, type BuildRouterOptions } from "./router";

export interface ShopifyMcpOAuth {
  router: Router;
  requireAuth: RequestHandler;
}

export function createShopifyMcpOAuth(
  config: ShopifyMcpOAuthConfig,
  options: BuildRouterOptions = {}
): ShopifyMcpOAuth {
  const resolved = resolveConfig(config);
  return {
    router: buildRouter(resolved, options),
    requireAuth: requireAuth(resolved),
  };
}

export { allowAnyShop } from "./adapters/allowAnyShop";
export { memoryCache } from "./adapters/memoryCache";
export { memoryStorage, type MemoryStorage } from "./adapters/memoryStorage";
export { prismaStorage, type PrismaLikeClient, type PrismaShopMapping } from "./adapters/prismaStorage";
export { redisCache, type RedisLikeClient } from "./adapters/redisCache";
export {
  shopifySessionStorage,
  type ShopifySessionLike,
  type ShopifySessionStorageLike,
} from "./adapters/shopifySessionStorage";
export { resolveConfig, type ResolvedConfig, type ShopifyMcpOAuthConfig } from "./config";
export { OAuthError } from "./errors";
export type { BuildRouterOptions } from "./router";
export type {
  CacheStore,
  Logger,
  McpAuthContext,
  NewOAuthClient,
  NewToken,
  OAuthClient,
  OAuthStorage,
  ShopRef,
  StoredToken,
} from "./types";
```

- [ ] **Step 5: Run the whole suite**

Run: `pnpm --filter shopify-mcp-oauth test`
Expected: PASS — every test from Tasks 2–20, including the 13 in `router.test.ts`.

- [ ] **Step 6: Verify typecheck and build**

Run: `pnpm --filter shopify-mcp-oauth typecheck && pnpm --filter shopify-mcp-oauth build`
Expected: no errors; `dist/` contains `index.js`, `index.cjs`, `index.d.ts`, `testing.js`, `testing.cjs`, `testing.d.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/shopify-mcp-oauth/src/router.ts packages/shopify-mcp-oauth/src/router.test.ts packages/shopify-mcp-oauth/src/index.ts
git rm --cached packages/shopify-mcp-oauth/src/index.test.ts 2>/dev/null || true
git add -A
git commit -m "feat: assemble the oauth router and public package exports"
```

---

## Task 21: Full-flow integration test

**Files:**
- Create: `packages/shopify-mcp-oauth/src/flow.test.ts`

**Interfaces:**
- Consumes: the entire public surface
- Produces: nothing — this task only proves the pieces fit together

Every prior task tested one unit against fakes. This one drives the whole login end to end with a
stubbed Shopify, which is the only way to catch a mismatch between two units that each pass their own
tests.

- [ ] **Step 1: Write the failing test**

`src/flow.test.ts`:

```ts
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "./adapters/memoryStorage";
import { sha256Base64Url } from "./crypto";
import { createShopifyMcpOAuth } from "./index";

const HOST = "https://mcp.example.com";
const API_SECRET = "test-api-secret";
const DEMO_SHOP = "demo.myshopify.com";
const DEMO_SHOP_ID = "shop_1";
const REDIRECT_URI = "https://client.example/callback";
const CLIENT_STATE = "client-state-value";
const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

function buildApp() {
  const oauth = createShopifyMcpOAuth({
    host: HOST,
    shopify: { apiKey: "test-api-key", apiSecret: API_SECRET, scopes: "read_products" },
    stateSecret: "test-state-secret-at-least-32-bytes-long",
    storage: memoryStorage({ shops: [{ id: DEMO_SHOP_ID, domain: DEMO_SHOP }] }),
    fetchImpl: vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "shpua_exchanged_token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ) as unknown as typeof fetch,
  });

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(oauth.router);
  app.post("/mcp", oauth.requireAuth, (req, res) => res.status(200).json({ shop: req.mcp?.shopDomain }));
  return app;
}

function signShopifyCallback(params: Record<string, string>): string {
  const message = new URLSearchParams(params).toString();
  const hmac = crypto.createHmac("sha256", API_SECRET).update(message).digest("hex");
  return `${message}&hmac=${hmac}`;
}

describe("full authorization flow", () => {
  it("carries a client from registration to an authenticated MCP call", async () => {
    const app = buildApp();

    const registration = await request(app).post("/register").send({
      client_name: "Flow Test Client",
      redirect_uris: [REDIRECT_URI],
    });
    expect(registration.status).toBe(201);
    const clientId = registration.body.client_id as string;

    const authorize = await request(app).get("/authorize").query({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: CLIENT_STATE,
      code_challenge: sha256Base64Url(CODE_VERIFIER),
      code_challenge_method: "S256",
    });
    expect(authorize.status).toBe(302);

    const shopifyRedirect = new URL(authorize.headers.location).searchParams.get("redirect") ?? "";
    const stateJwt = new URLSearchParams(shopifyRedirect.split("?")[1]).get("state") ?? "";

    const callbackQuery = signShopifyCallback({ shop: DEMO_SHOP, code: "shopify-code", state: stateJwt });
    const callback = await request(app).get(`/oauth/shopify-callback?${callbackQuery}`);
    expect(callback.status).toBe(302);

    const authorizationCode = new URL(callback.headers.location).searchParams.get("code") ?? "";
    expect(new URL(callback.headers.location).searchParams.get("state")).toBe(CLIENT_STATE);

    const tokenResponse = await request(app).post("/token").type("form").send({
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: CODE_VERIFIER,
    });
    expect(tokenResponse.status).toBe(200);

    const call = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${tokenResponse.body.access_token}`)
      .send({});
    expect(call.status).toBe(200);
    expect(call.body.shop).toBe(DEMO_SHOP);

    const refreshed = await request(app).post("/token").type("form").send({
      grant_type: "refresh_token",
      refresh_token: tokenResponse.body.refresh_token,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);

    const afterRevoke = await request(app).post("/revoke").send({ token: refreshed.body.access_token });
    expect(afterRevoke.status).toBe(200);

    const blocked = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${refreshed.body.access_token}`)
      .send({});
    expect(blocked.status).toBe(401);
  });

  it("stops an uninstalled shop at the callback", async () => {
    const oauth = createShopifyMcpOAuth({
      host: HOST,
      shopify: { apiKey: "test-api-key", apiSecret: API_SECRET, scopes: "read_products" },
      stateSecret: "test-state-secret-at-least-32-bytes-long",
      storage: memoryStorage(),
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ access_token: "shpua_exchanged_token" }), { status: 200 })
      ) as unknown as typeof fetch,
    });
    const app = express();
    app.use(express.json());
    app.use(oauth.router);

    const registration = await request(app).post("/register").send({ redirect_uris: [REDIRECT_URI] });
    const authorize = await request(app).get("/authorize").query({
      response_type: "code",
      client_id: registration.body.client_id,
      redirect_uri: REDIRECT_URI,
      state: CLIENT_STATE,
      code_challenge: sha256Base64Url(CODE_VERIFIER),
      code_challenge_method: "S256",
    });
    const shopifyRedirect = new URL(authorize.headers.location).searchParams.get("redirect") ?? "";
    const stateJwt = new URLSearchParams(shopifyRedirect.split("?")[1]).get("state") ?? "";

    const callbackQuery = signShopifyCallback({ shop: DEMO_SHOP, code: "shopify-code", state: stateJwt });
    const callback = await request(app).get(`/oauth/shopify-callback?${callbackQuery}`);
    expect(callback.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter shopify-mcp-oauth test src/flow.test.ts`
Expected: PASS, 2 tests. If a step fails, the mismatch is between two units that each pass in
isolation — fix the unit, not the flow test.

- [ ] **Step 3: Run the whole suite one final time**

Run: `pnpm --filter shopify-mcp-oauth test && pnpm --filter shopify-mcp-oauth typecheck && pnpm --filter shopify-mcp-oauth build`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add packages/shopify-mcp-oauth/src/flow.test.ts
git commit -m "test: cover the full authorization flow end to end"
```

---

## Done

At this point `shopify-mcp-oauth` is feature-complete against the spec's §3 and ready to be consumed
by plan 2's example server. Not yet built, by design: the example app, the CLI, the README, and CI —
those are plans 2 and 3.

