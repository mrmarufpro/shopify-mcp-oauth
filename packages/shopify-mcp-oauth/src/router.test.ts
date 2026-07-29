import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "./adapters/memoryStorage";
import { resolveConfig } from "./config";
import type { BuildRouterOptions } from "./router";
import { signOuterState } from "./services/stateJwt";
import { issueTokens } from "./services/tokens";
import type { Logger } from "./types";
import { createShopifyMcpOAuth, type ShopifyMcpOAuthConfig } from "./index";

const HOST = "https://mcp.example.com";
const DEMO_SHOP = "demo.myshopify.com";
const DEMO_SHOP_ID = "shop_1";
const REDIRECT_URI = "https://client.example/callback";
const SHOPIFY_API_KEY = "test-api-key";
const SHOPIFY_API_SECRET = "test-api-secret";
const STATE_SECRET = "test-state-secret-at-least-32-bytes-long";

// Silent by default so the no-cache warning (and, in the error-handler tests, the deliberately
// triggered error log) doesn't spray stderr across every case that isn't about it.
const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function buildBaseConfig(overrides: Partial<ShopifyMcpOAuthConfig> = {}): ShopifyMcpOAuthConfig {
  return {
    host: HOST,
    shopify: { apiKey: SHOPIFY_API_KEY, apiSecret: SHOPIFY_API_SECRET, scopes: "read_products" },
    stateSecret: STATE_SECRET,
    storage: memoryStorage({ shops: [{ id: DEMO_SHOP_ID, domain: DEMO_SHOP }] }),
    logger: silentLogger,
    ...overrides,
  };
}

function buildApp() {
  const oauth = createShopifyMcpOAuth(buildBaseConfig());
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(oauth.router);
  app.post("/mcp", oauth.requireAuth, (req, res) => res.status(200).json(req.mcp));
  return app;
}

// Split by which document each path must serve, not just "does it 200" -- both controllers
// answer 200 for any of these six paths, so a request-level test that only checks status can't
// tell a correctly-wired route apart from one silently cross-wired to the OTHER metadata
// controller (verified by mutation: swapping protectedResourceMetadataController for
// authorizationServerMetadataController on the two oauth-protected-resource routes left the full
// suite green). Each group below asserts a field that only its own document carries.
const AUTHORIZATION_SERVER_METADATA_PATHS = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/mcp",
  "/.well-known/openid-configuration",
  "/.well-known/openid-configuration/mcp",
];

const PROTECTED_RESOURCE_METADATA_PATHS = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
];

describe("router", () => {
  it.each(AUTHORIZATION_SERVER_METADATA_PATHS)("serves authorization server metadata at %s", async (path) => {
    const response = await request(buildApp()).get(path);
    expect(response.status).toBe(200);
    // authorization_endpoint exists only on the authorization-server document (see
    // serializers/metadata.ts) -- the protected-resource document has no such field.
    expect(response.body.authorization_endpoint).toBe(`${HOST}/authorize`);
  });

  it.each(PROTECTED_RESOURCE_METADATA_PATHS)("serves protected resource metadata at %s", async (path) => {
    const response = await request(buildApp()).get(path);
    expect(response.status).toBe(200);
    // resource exists only on the protected-resource document -- the authorization-server
    // document has no such field.
    expect(response.body.resource).toBe(`${HOST}/mcp`);
  });

  it("mounts /register", async () => {
    const response = await request(buildApp())
      .post("/register")
      .send({ redirect_uris: [REDIRECT_URI] });
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

  // The request-level test above is not enough on its own: openaiAppsChallengeController itself
  // 404s when handed a null token, so unconditionally registering the route regardless of
  // config -- `router.get(path, openaiAppsChallengeController(config.openaiAppsChallengeToken))`
  // with no `if` at all -- produces the exact same 404 response and would NOT redden that test.
  // Verified by mutation. This asserts the thing that actually distinguishes the two: no layer
  // for that path exists in the router's own stack at all when the token isn't configured.
  it("does not register a layer for the openai challenge path at all when no token is configured", () => {
    const oauth = createShopifyMcpOAuth(buildBaseConfig());
    const stack = (oauth.router as unknown as { stack: Array<{ route?: { path: string } }> }).stack;
    const matchingLayer = stack.find((layer) => layer.route?.path === "/.well-known/openai-apps-challenge");
    expect(matchingLayer).toBeUndefined();
  });

  // The two tests above only ever pin the ABSENT case. Nothing proved the route is actually
  // served -- through buildRouter, not a bare app mounting the controller directly -- when a
  // token IS configured. controllers/metadata.test.ts mounts openaiAppsChallengeController on its
  // own bare app, bypassing buildRouter entirely, so it can't stand in for this either.
  it("serves the configured challenge token through the full router when one is configured", async () => {
    const CHALLENGE_TOKEN = "openai-challenge-token-value";
    const oauth = createShopifyMcpOAuth(buildBaseConfig({ openaiAppsChallengeToken: CHALLENGE_TOKEN }));
    const app = express();
    app.use(oauth.router);

    const response = await request(app).get("/.well-known/openai-apps-challenge");

    expect(response.status).toBe(200);
    expect(response.text).toBe(CHALLENGE_TOKEN);
  });
});

describe("requireAuth accepts a token this server actually issued", () => {
  // "guards the mcp route with requireAuth" above only pins the REJECT direction (no token ->
  // 401) -- an always-401 stub swapped in for requireAuth would leave that test green too
  // (verified by mutation). This drives a real token, issued through the exact same config's
  // storage, all the way through buildRouter + requireAuth and checks it's actually accepted.
  it("returns 200 and populates req.mcp for a valid access token", async () => {
    const config = buildBaseConfig();
    const oauth = createShopifyMcpOAuth(config);
    const app = express();
    app.use(oauth.router);
    app.post("/mcp", oauth.requireAuth, (req, res) => res.status(200).json(req.mcp));

    // Same `config` object resolveConfig was already called on inside createShopifyMcpOAuth --
    // resolving it again here is side-effect-free (beyond the harmless no-cache log) and shares
    // the identical `storage` instance by reference, so a token issued against this resolved copy
    // is visible to requireAuth's lookups against the router's own copy.
    const resolved = resolveConfig(config);
    const tokens = await issueTokens(resolved, {
      shopId: DEMO_SHOP_ID,
      shopDomain: DEMO_SHOP,
      clientId: "test-client-id",
    });

    const response = await request(app).post("/mcp").set("Authorization", `Bearer ${tokens.access_token}`).send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ shopId: DEMO_SHOP_ID, shopDomain: DEMO_SHOP, tokenId: expect.any(String) });
  });
});

describe("createShopifyMcpOAuth", () => {
  it("throws on an invalid host before any request is served", () => {
    expect(() =>
      createShopifyMcpOAuth({
        host: "mcp.example.com",
        shopify: { apiKey: SHOPIFY_API_KEY, apiSecret: SHOPIFY_API_SECRET, scopes: "read_products" },
        stateSecret: STATE_SECRET,
        storage: memoryStorage(),
      })
    ).toThrow(/host/);
  });
});

// A genuinely valid, signed outer state -- not a throwaway string -- is what makes the HMAC tests
// below actually isolate the HMAC guard rather than incidentally failing on state verification
// instead. Shared by both the negative and positive HMAC describe blocks.
function validSignedState(): string {
  return signOuterState(
    {
      clientId: "test-client-id",
      redirectUri: REDIRECT_URI,
      clientState: "client-state",
      codeChallenge: "a".repeat(43),
      codeChallengeMethod: "S256",
      resource: `${HOST}/mcp`,
      nonce: "test-nonce-value",
    },
    STATE_SECRET,
    600
  );
}

describe("the shopify callback route requires a valid HMAC", () => {
  function callbackQuery(hmacValue: string): string {
    return new URLSearchParams({
      shop: DEMO_SHOP,
      code: "some-code",
      state: validSignedState(),
      timestamp: "1700000000",
      hmac: hmacValue,
    }).toString();
  }

  it("rejects a callback request with an invalid HMAC, and never reaches the controller", async () => {
    const fetchImpl = vi.fn();
    const oauth = createShopifyMcpOAuth(buildBaseConfig({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    const app = express();
    app.use(oauth.router);

    const response = await request(app).get(`/oauth/shopify-callback?${callbackQuery("not-a-real-signature")}`);

    expect(response.status).toBe(400);
    // shopifyCallbackController only calls config.fetchImpl (the Shopify token exchange) after
    // this valid state successfully verifies -- so fetchImpl staying uncalled proves the request
    // never got past requireShopifyHmac into the controller, not that it failed downstream for an
    // unrelated reason. Mutation-verified for this task: deleting `requireShopifyHmac(...)` from
    // the /oauth/shopify-callback route in router.ts turns this red (status becomes 500 and
    // fetchImpl.not.toHaveBeenCalled() fails, because the controller then runs, the valid state
    // verifies, and it proceeds to call the bare `vi.fn()` fetchImpl).
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the shopify callback route accepts a genuinely valid HMAC", () => {
  // The negative test above only pins the REJECT direction -- it would stay equally green if
  // router.ts wired requireShopifyHmac to the WRONG secret entirely (e.g. config.stateSecret
  // instead of config.shopify.apiSecret), since a request signed with neither secret is rejected
  // either way. Verified by mutation. This signs with the REAL secret the wiring is supposed to
  // use and asserts the request is actually accepted through to a full, successful redirect --
  // not just that the HMAC check itself passes.
  function signQuery(params: Record<string, string>): string {
    // Sorted by key, mirroring the algorithm verifyShopifyHmac.test.ts's own signQuery uses (the
    // one Shopify's docs document) -- see that file for why this is an accurate stand-in for how
    // Shopify actually signs a callback.
    const sortedEntries = Object.entries(params).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const message = new URLSearchParams(sortedEntries).toString();
    const hmac = crypto.createHmac("sha256", SHOPIFY_API_SECRET).update(message).digest("hex");
    return `${message}&hmac=${hmac}`;
  }

  it("passes a request signed with the real shopify.apiSecret all the way through to a successful redirect", async () => {
    const shopifyExchangeResponse = new Response(JSON.stringify({ access_token: "shopify-admin-token" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const fetchImpl = vi.fn().mockResolvedValue(shopifyExchangeResponse);
    const oauth = createShopifyMcpOAuth(buildBaseConfig({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    const app = express();
    app.use(oauth.router);

    const queryString = signQuery({ shop: DEMO_SHOP, code: "some-code", state: validSignedState() });
    const response = await request(app).get(`/oauth/shopify-callback?${queryString}`);

    // fetchImpl is only ever called once the HMAC guard AND state verification both succeed --
    // proving this got past requireShopifyHmac using the real secret, not just that some other
    // check happened not to fire.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(302);
    expect(response.headers.location).toContain("code=");
  });
});

describe("terminal error handler", () => {
  function buildFullyWiredApp() {
    const oauth = createShopifyMcpOAuth(buildBaseConfig());
    const app = express();
    app.use(express.json());
    app.use(oauth.router);
    // Mounted LAST, at the top level -- after the consumer's own body-parser and after
    // oauth.router -- which is the only placement that can catch a body-parser error (see
    // src/middlewares/errorHandler.ts for why this can't be automatic).
    app.use(oauth.errorHandler);
    return app;
  }

  it("converts a malformed JSON body into the generic safe shape instead of Express's default HTML stack trace", async () => {
    const response = await request(buildFullyWiredApp())
      .post("/register")
      .set("Content-Type", "application/json")
      .send('{"redirect_uris": [invalid');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "server_error", error_description: "An unexpected error occurred" });
    expect(response.headers["content-type"]).toContain("json");
  });

  it("never leaks the SyntaxError message or a stack trace in that response", async () => {
    const response = await request(buildFullyWiredApp())
      .post("/register")
      .set("Content-Type", "application/json")
      .send('{"redirect_uris": [invalid');

    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain("SyntaxError");
    expect(raw).not.toContain("JSON.parse");
    expect(raw).not.toContain(".ts:");
  });

  // "converts a malformed JSON body..." above only asserts the RESPONSE, which is identical
  // whether errorHandler(resolved.logger) or errorHandler({ ...a hardcoded no-op logger }) built
  // the mount -- the body and status don't carry the logger. Verified by mutation: swapping
  // resolved.logger for a hardcoded no-op in index.ts left the full suite green. The log is a
  // side channel the response can't prove one way or the other; this drives the configured
  // logger's spy directly.
  it("threads the caller's configured logger into the exported errorHandler, not a hardcoded one", async () => {
    const errorLog = vi.fn();
    const oauth = createShopifyMcpOAuth(
      buildBaseConfig({ logger: { info: () => {}, warn: () => {}, error: errorLog } })
    );
    const app = express();
    app.use(express.json());
    app.use(oauth.router);
    app.use(oauth.errorHandler);

    await request(app).post("/register").set("Content-Type", "application/json").send('{"redirect_uris": [invalid');

    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it("leaks Express's own HTML stack trace when the consumer does not mount oauth.errorHandler, proving that mount is load-bearing", async () => {
    const oauth = createShopifyMcpOAuth(buildBaseConfig());
    const app = express();
    app.use(express.json());
    app.use(oauth.router);
    // No app.use(oauth.errorHandler) here -- the gap this test exists to prove is real.

    const response = await request(app)
      .post("/register")
      .set("Content-Type", "application/json")
      .send('{"redirect_uris": [invalid');

    expect(response.body).not.toEqual({ error: "server_error", error_description: "An unexpected error occurred" });
    expect(response.text).toContain("SyntaxError");
  });

  // Every controller mounted on `oauth.router` is already wrapped in asyncHandler, and none of
  // the middlewares router.ts mounts directly (requireShopifyHmac, createRateLimiter) ever throw
  // synchronously or call next(err) in this codebase today -- so there is currently no request
  // that can make the router-internal errorHandler mount actually fire. Its value is structural:
  // it protects a *future* controller that forgets to wrap with asyncHandler, or a synchronous
  // throw added later to one of those middlewares. That can't be pinned by sending a request (there
  // isn't one that reaches it), so this asserts the thing that actually matters -- an error-
  // handling (4-arg) layer sits LAST in the router's own stack -- directly on the router's shape.
  it("mounts an error-handling (4-arg) layer as the last layer in the router's own stack", () => {
    const oauth = createShopifyMcpOAuth(buildBaseConfig());
    const stack = (oauth.router as unknown as { stack: Array<{ handle: (...args: unknown[]) => unknown }> }).stack;
    const lastLayer = stack[stack.length - 1];
    expect(lastLayer?.handle.length).toBe(4);
  });

  // No request today reaches this mount (see the comment above), so its logger pass-through can't
  // be pinned by sending one either -- but `lastLayer.handle` IS the exact closure
  // `errorHandler(config.logger)` returned inside buildRouter, captured `logger` and all. Invoking
  // it directly (the same call shape Express itself uses once a layer is chosen: err, req, res,
  // next) exercises that real closure without needing Express's dispatch to reach it.
  it("threads the configured logger into the router-internal errorHandler mount too", () => {
    const errorLog = vi.fn();
    const oauth = createShopifyMcpOAuth(
      buildBaseConfig({ logger: { info: () => {}, warn: () => {}, error: errorLog } })
    );
    const stack = (oauth.router as unknown as { stack: Array<{ handle: (...args: unknown[]) => unknown }> }).stack;
    const lastLayer = stack[stack.length - 1];

    const fakeRes = { headersSent: false, status: () => ({ json: () => undefined }) };
    lastLayer?.handle(new Error("synthetic error for direct invocation"), {}, fakeRes, () => {});

    expect(errorLog).toHaveBeenCalledTimes(1);
  });
});

describe("mounts a rate limiter on /register", () => {
  // Mirrors the /revoke block below exactly. The brief already wired createRateLimiter onto
  // /register; nothing in this file had actually driven it past its own configured limit through
  // the fully-wired app before this test existed -- unmounting it left the full suite green.
  it("answers 429 once the configured register rate limit is exceeded", async () => {
    const oauth = createShopifyMcpOAuth(buildBaseConfig({ registerRateLimit: { limit: 1, windowMs: 60_000 } }));
    const app = express();
    app.use(express.json());
    app.use(oauth.router);

    const first = await request(app)
      .post("/register")
      .send({ redirect_uris: [REDIRECT_URI] });
    const second = await request(app)
      .post("/register")
      .send({ redirect_uris: [REDIRECT_URI] });

    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
    expect(second.body.error).toBe("too_many_requests");
    expect(second.headers["retry-after"]).toBeDefined();
  });

  // The test above uses limit: 1 and only checks Retry-After is present -- any windowMs at all
  // satisfies that, so it can't tell the configured window from a wrong (e.g. hardcoded) one.
  // Retry-After is the one response value that actually carries windowMs, so a distinct,
  // non-default window here is what makes a wrong pass-through observable.
  it("threads the configured registerRateLimit.windowMs into the limiter, not just the limit", async () => {
    const CONFIGURED_WINDOW_MS = 120_000;
    const oauth = createShopifyMcpOAuth(
      buildBaseConfig({ registerRateLimit: { limit: 1, windowMs: CONFIGURED_WINDOW_MS } })
    );
    const app = express();
    app.use(express.json());
    app.use(oauth.router);

    await request(app)
      .post("/register")
      .send({ redirect_uris: [REDIRECT_URI] });
    const blocked = await request(app)
      .post("/register")
      .send({ redirect_uris: [REDIRECT_URI] });

    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBe(String(CONFIGURED_WINDOW_MS / 1000));
  });
});

describe("mounts a rate limiter on /revoke", () => {
  it("answers 429 once the configured revoke rate limit is exceeded", async () => {
    const oauth = createShopifyMcpOAuth(buildBaseConfig({ revokeRateLimit: { limit: 1, windowMs: 60_000 } }));
    const app = express();
    app.use(express.json());
    app.use(oauth.router);

    const first = await request(app).post("/revoke").send({ token: "first-guess" });
    const second = await request(app).post("/revoke").send({ token: "second-guess" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.body.error).toBe("too_many_requests");
    expect(second.headers["retry-after"]).toBeDefined();
  });

  // Same gap as /register's windowMs test above, mirrored onto /revoke.
  it("threads the configured revokeRateLimit.windowMs into the limiter, not just the limit", async () => {
    const CONFIGURED_WINDOW_MS = 120_000;
    const oauth = createShopifyMcpOAuth(
      buildBaseConfig({ revokeRateLimit: { limit: 1, windowMs: CONFIGURED_WINDOW_MS } })
    );
    const app = express();
    app.use(express.json());
    app.use(oauth.router);

    await request(app).post("/revoke").send({ token: "first-guess" });
    const blocked = await request(app).post("/revoke").send({ token: "second-guess" });

    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBe(String(CONFIGURED_WINDOW_MS / 1000));
  });

  it("keeps the revoke and register rate limits independent of one another", async () => {
    const oauth = createShopifyMcpOAuth(
      buildBaseConfig({
        revokeRateLimit: { limit: 1, windowMs: 60_000 },
        registerRateLimit: { limit: 5, windowMs: 60_000 },
      })
    );
    const app = express();
    app.use(express.json());
    app.use(oauth.router);

    await request(app).post("/revoke").send({ token: "spends-the-one-revoke-slot" });
    const blockedRevoke = await request(app).post("/revoke").send({ token: "another-guess" });
    const stillAllowedRegister = await request(app)
      .post("/register")
      .send({ redirect_uris: [REDIRECT_URI] });

    expect(blockedRevoke.status).toBe(429);
    expect(stillAllowedRegister.status).toBe(201);
  });
});

describe("allowPrivateCimdHosts option flows from createShopifyMcpOAuth through to /authorize", () => {
  const PRIVATE_CIMD_CLIENT_ID = "https://127.0.0.1/metadata.json";
  const CODE_CHALLENGE = "a".repeat(43);
  const authorizeQuery = {
    response_type: "code",
    client_id: PRIVATE_CIMD_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state: "client-state",
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
  };

  function buildAppWithOptions(options: BuildRouterOptions) {
    const cimdResponse = new Response(JSON.stringify({ client_name: "Test Client", redirect_uris: [REDIRECT_URI] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const oauth = createShopifyMcpOAuth(
      buildBaseConfig({ fetchImpl: vi.fn().mockResolvedValue(cimdResponse) as unknown as typeof fetch }),
      options
    );
    const app = express();
    app.use(oauth.router);
    return app;
  }

  it("rejects a private-host CIMD client_id by default (options omitted)", async () => {
    const response = await request(buildAppWithOptions({})).get("/authorize").query(authorizeQuery);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_client");
  });

  it("allows a private-host CIMD client_id through when allowPrivateCimdHosts is true", async () => {
    const response = await request(buildAppWithOptions({ allowPrivateCimdHosts: true }))
      .get("/authorize")
      .query(authorizeQuery);
    expect(response.status).toBe(302);
  });
});
