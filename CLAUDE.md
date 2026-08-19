# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

pnpm workspace, Node >= 20; the root scripts are in `package.json`.

`pnpm build` must run before `pnpm typecheck` and before anything that touches
`examples/basic-server`: the example depends on `shopify-mcp-oauth` through its `exports` map, which
points at `dist/`. CI runs `install → build → lint → typecheck → test → sync:template` on Node 20 and 22.

Single package / single file / single test:

```bash
pnpm --filter shopify-mcp-oauth test                       # one package's suite
pnpm --filter shopify-mcp-oauth test src/router.test.ts    # one file
pnpm --filter shopify-mcp-oauth test -t "rejects plain"    # one test by name
pnpm --filter create-shopify-mcp test
CREATE_SHOPIFY_MCP_E2E=1 pnpm --filter create-shopify-mcp test   # also scaffolds against real GitHub
```

## Layout

Two packages plus an example. The non-obvious part: `examples/basic-server` is the three-file demo,
**and** the source the scaffolder's template is generated from, **and** a directory the published CLI
downloads from GitHub at runtime for `--example basic-server`. `docs/` is prettier-ignored.

### The template is generated, never edited

`packages/create-shopify-mcp/templates/` is **gitignored and produced by
`scripts/sync-template.mjs`**, which copies `examples/basic-server` minus build output and lockfiles,
then renames its committed `.gitignore` to `gitignore` (undotted; npm strips `.gitignore` from a
published tarball, so the CLI re-dots it on copy). There is no dependency-rewriting step any more:
the example pins `"shopify-mcp-oauth": "latest"` directly, which is already a specifier a scaffolded
project can install, and `linkWorkspacePackages: true` in `pnpm-workspace.yaml` is what still
resolves it to the local package inside this repository. To change what a scaffolded project
contains, edit `examples/basic-server` and run `pnpm sync:template`. Never hand-edit
`templates/default`. `scaffold.integration.test.ts` runs the sync itself before asserting, CI fails
if the synced manifest still carries a `workspace:` specifier, and `rewritePackageJson` throws on one
at scaffold time — so a `workspace:` protocol that escapes into an example is reported as that
example's fault rather than surfacing to a user as an opaque pnpm resolution error.

## create-shopify-mcp architecture

`run.ts` orchestrates; every other module does one thing (`args`, `example`, `download`, `copy`,
`packageJson`, `target`, `git`, `nextSteps`, `retry`).

With no `--example` — and with `--example default`, a reserved spelling — the CLI copies its bundled
template and **never touches the network**. `--example <name>` downloads `examples/<name>` from this
repository; `--example <github-url>` (optionally with `--example-path`) downloads any directory of
any public repository.

- **Ref resolution** (`example.ts`): a bare name resolves to the **newest GitHub release**, falling
  back to `main` only on a 404 from `/releases/latest`. That 404 check is deliberately narrow — any
  non-200 used to fall back, which silently defeated release-pinning exactly when an unauthenticated
  caller hit GitHub's 60-request-per-hour ceiling and got a 403.
- **Existence check before anything is created** (`download.ts`): `exampleExists` HEADs the contents
  API for the example's `package.json`, which is why a typo is reported by name and leaves no
  directory behind. It is also why every example must ship a `package.json`.
- **Extraction** streams `codeload.github.com/<owner>/<repo>/tar.gz/<ref>` through `tar.x` with a
  subpath `filter` and a computed `strip`. The archive root is read off the first entry rather than
  reconstructed from owner/repo/ref, so a renamed repository still extracts. `tar`'s `filter` sees
  the **pre-strip** path.
- **Failure cleanup** (`run.ts`) removes the target directory **only when the CLI created it**.
  Existence is recorded before `prepareTarget`, because `prepareTarget` deliberately accepts a
  directory holding nothing but `.git` (or editor/OS droppings) — an unconditional `rm` there would
  delete a user's repository.
- **`tar` belongs in `dependencies`, not `devDependencies`.** tsup externalises whatever is listed in
  `dependencies`; demoting it leaves the published CLI unable to resolve its own extractor at
  runtime.

All network access goes through an injected `deps.fetch`, so every test except the env-gated
`e2e.network.test.ts` runs offline.

`examples/README.md` is the authoring contract for anything added under `examples/`: a downloaded
example has to stand on its own once unpacked elsewhere (its own `.gitignore` and `README.md`, since
the repository root's do not travel with a subpath download), and **cutting a GitHub release is what
keeps `--example` coherent** — publishing `shopify-mcp-oauth` to npm without tagging leaves the CLI
on the `main` fallback, handing out examples that expect an unpublished API.

## shopify-mcp-oauth architecture

Entry points are `createShopifyMcpOAuth(config, options)` (returns a handle) and
`mountShopifyMcpOAuth(app, config, registerProtectedRoutes, options)` (mounts it in the one order
that works). The handle is `{ router, requireAuth, errorHandler, authenticate, challenge }` — note
`createAuthenticator`'s object is `Object.assign`-ed into the handle, so `oauth.authenticate` and the
function `requireAuth` calls are the same property; don't spread it into a fresh literal.

Directory layering inside `src/`:

- `router.ts` — the only place routes are declared. Body parsers are applied **per route**, never
  `router.use`, so a consumer's MCP transport keeps its raw stream.
- `middlewares/` — `requireAuth`, `errorHandler`, `verifyShopifyHmac`, `rateLimit`.
- `controllers/` — one per endpoint, each wrapped in `asyncHandler`. HTTP-shaped only.
- `services/` — the logic: `codes`, `tokens`, `pkce`, `stateJwt`, `cimd`, `redirectUri`,
  `concurrencyLimiter`.
- `schemas/` (zod request parsing), `serializers/` (response shaping).
- `adapters/` — the ports: `memoryStorage`, `prismaStorage`, `shopifySessionStorage`, `allowAnyShop`,
  `memoryCache`, `redisCache`.
- `config.ts` — `resolveConfig` validates everything at construction and throws naming the field. All
  downstream code takes `ResolvedConfig`, never the raw input.
- `types.ts` — the `OAuthStorage` / `CacheStore` ports, plus the global `Express.Request`
  augmentation for `req.mcp` (declared against the `Express` namespace, not
  `express-serve-static-core`, for pnpm-strict resolution; it is also colocated there for tsup's dts
  bundler).

Two build entry points: `.` (`src/index.ts`) and `./testing` (`src/testing/index.ts`, the storage and
cache contract-test suites consumers run against their own adapters).

### Login flow

Client discovers via `/.well-known/*` (six documents, several aliases — a 404 on the one a given
client probes reads as "no OAuth support") → identifies itself by client-metadata URL (CIMD) or
`/register` → `/authorize` with PKCE S256 → redirect to Shopify's shop picker → Shopify hits
`/oauth/shopify-callback`, HMAC-verified against the **raw query string** before the controller runs
→ install gate (`findShopByDomain`, then `onShopNotFound`, else 403) → 60-second authorization code
in the cache → `/token` → access + rotating refresh token → `POST /mcp` with the bearer token.

The Shopify access token is exchanged as proof of shop control and then **discarded** — only
`onShopNotFound` ever sees it.

### Invariants worth knowing before changing anything

- **Error handler last.** Express only searches for an error handler at the stack level where the
  error was thrown, so a body-parser `SyntaxError` never reaches one mounted inside a router.
  `mountShopifyMcpOAuth` makes the ordering structural; its callback parameter is required, not
  optional, precisely to rule out routes registered below the handler.
- **`requireAuth` = `authenticate` + `challenge`.** `authenticate` never touches the response;
  `challenge` writes the RFC 9728 `WWW-Authenticate` header and no-ops if headers were already sent.
- **Token audience.** `resolveConfig` normalizes `host` via `new URL()` (lowercased, default port
  dropped) because `resource` matching is plain string equality.
- **Shop identity is re-checked per request.** `authenticate` re-resolves the shop by domain and
  compares `String(stored.shopId) !== String(shop.id)` — this is what invalidates a token minted
  before an uninstall/reinstall. A `ShopNotFoundHandler` returning a synthesized id makes login
  succeed and every tool call 401, which MCP clients turn into a login loop.
- **`CacheStore.getdel` must be atomic** — it is what makes an authorization code single-use.
  `redisCache` uses a queued `MULTI GET+DEL` deliberately (`GETDEL` only exists on Redis >= 6.2) and
  falls back to `getDel` only for a client with no `multi()`.
- **Tokens are stored as SHA-256 hashes**; cache keys are the code's hash, not the code.
- PKCE `plain` is rejected at every layer. `/token`'s `redirect_uri` check is exact — the loopback
  port flexibility (RFC 8252) belongs only in `/authorize`'s registered-URI match.
- **The `/register` and `/revoke` rate limiters are opt-in and off by default** (`registerRateLimit` /
  `revokeRateLimit`; omitted or `false` resolves to `null`, and `null` means no layer is mounted at
  all). Omitting warns at construction, `false` does not — that difference is the only reason `false`
  is accepted. Counting is express-rate-limit's, so a shared `store` is a config field and per-process
  counting is the default, not a law. The CIMD fetch cap is a different thing entirely: a global
  concurrency limiter, not a per-IP one.

## Testing conventions

Vitest, `src/**/*.test.ts`, colocated with the unit under test. `flow.test.ts` is the end-to-end
login walkthrough; `mount.test.ts` covers mounting order; controller/middleware tests build their own
supertest app.

`packages/shopify-mcp-oauth/src/vitestSetup.ts` adds a 15 ms `afterEach` cool-down. It is not
decoration — it addresses a reproduced, rate-dependent ephemeral-port race between this suite's many
short-lived supertest servers. Read the comment before touching it.

Fake timers are used in several files and always restored before the test body returns.

## Style

The dominant convention in this codebase is **long explanatory comments that record why a decision
was made** — which RFC requires it, what breaks silently without it, what alternative was tried and
rejected. Match that when editing: a change that removes such a comment's premise should update the
comment, and new non-obvious logic is expected to carry one. Public API surfaces (`index.ts`,
`types.ts`) carry the same reasoning as TSDoc.
