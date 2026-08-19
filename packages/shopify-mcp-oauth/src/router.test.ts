import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "./adapters/memoryStorage";
import { RECOMMENDED_RATE_LIMIT, resolveConfig } from "./config";
import { errorHandler as oauthErrorHandler } from "./middlewares/errorHandler";
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

// Every controller under this router reads req.body, but nothing in Express parses one by
// default. Leaving that to the consumer meant a server whose own app only mounts express.json()
// -- the obvious thing to mount, and what this project's own README used to show -- served a
// /token endpoint that saw an empty body for the form encoding RFC 6749 §4.1.3 clients actually
// send, and answered "grant_type is required" to a request that carried one. The router mounts
// what its own routes need, on its own routes only.
describe("the router parses its own request bodies", () => {
  function buildAppWithoutBodyParsers() {
    const oauth = createShopifyMcpOAuth(buildBaseConfig());
    const app = express();
    app.use(oauth.router);
    app.use(oauth.errorHandler);
    return app;
  }

  it("reads a form-encoded /token body with no consumer-mounted parser", async () => {
    const response = await request(buildAppWithoutBodyParsers())
      .post("/token")
      .type("form")
      .send({ grant_type: "refresh_token", refresh_token: "not-a-real-token", client_id: "some-client" });

    // The point is that the body arrived at all: a request whose grant_type never landed is
    // rejected as invalid_request instead, which is what an unparsed body produces.
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_grant");
  });

  it("reads a JSON /token body with no consumer-mounted parser", async () => {
    const response = await request(buildAppWithoutBodyParsers())
      .post("/token")
      .send({ grant_type: "refresh_token", refresh_token: "not-a-real-token", client_id: "some-client" });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_grant");
  });

  it("reads a JSON /register body with no consumer-mounted parser", async () => {
    const response = await request(buildAppWithoutBodyParsers())
      .post("/register")
      .send({ redirect_uris: [REDIRECT_URI], client_name: "Parser Test Client" });

    expect(response.status).toBe(201);
    expect(response.body.client_id).toEqual(expect.any(String));
  });

  it("reads a form-encoded /revoke body with no consumer-mounted parser", async () => {
    const response = await request(buildAppWithoutBodyParsers()).post("/revoke").type("form").send({ token: "abc" });

    // RFC 7009: 200 whether or not the token existed. An unparsed body would be a 400 instead.
    expect(response.status).toBe(200);
  });

  // body-parser skips a request whose stream is already drained (`onFinished.isFinished(req)` in
  // its lib/read.js -- the 1.x `req._body` flag is gone in the 2.x Express 5 depends on), so the
  // router's own parsers are a no-op on a consumer that mounts theirs first. That has to stay true,
  // because double-reading a consumed stream would hang the request rather than fail it loudly.
  it("does not disturb a consumer that already mounted its own parsers", async () => {
    const response = await request(buildApp())
      .post("/register")
      .send({ redirect_uris: [REDIRECT_URI], client_name: "Double Parser Client" });

    expect(response.status).toBe(201);
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

  it("converts a malformed JSON body into a safe 400 instead of Express's default HTML stack trace", async () => {
    const response = await request(buildFullyWiredApp())
      .post("/register")
      .set("Content-Type", "application/json")
      .send('{"redirect_uris": [invalid');

    // The client sent a body this server could not parse, and body-parser says so on the error it
    // throws (`status: 400`). Answering 500 would blame the server for the caller's mistake, and on
    // /token specifically it breaks RFC 6749 §5.2 -- a client told `server_error` retries a request
    // that can never succeed, where `invalid_request` tells it to stop.
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "invalid_request",
      error_description: "The request body could not be parsed",
    });
    expect(response.headers["content-type"]).toContain("json");
  });

  // Same handler, the other branch: an error carrying no client status is still this server's
  // fault and must still be the opaque 500. Without this, honouring `err.status` could regress into
  // honouring anything at all and no test would notice.
  it("still answers an opaque 500 for an error that carries no client status", async () => {
    const errorLog = vi.fn();
    const app = express();
    app.get("/boom", () => {
      throw new Error("synthetic non-client failure");
    });
    // Mounted after the route: Express only searches forward from where the error occurred, so a
    // handler mounted above the throwing layer is never reached.
    app.use(oauthErrorHandler({ info: () => {}, warn: () => {}, error: errorLog }));

    const response = await request(app).get("/boom");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "server_error", error_description: "An unexpected error occurred" });
    expect(errorLog).toHaveBeenCalled();
  });

  // Now that the parsers are mounted on the router's own routes, the throw happens INSIDE the
  // router's stack, so the handler router.ts mounts internally catches it with no app-level mount
  // in sight. That is a genuinely different origin from every other case in this block (all of
  // which route through the consumer's own `app.use(oauth.errorHandler)`), and it is the one a
  // consumer who followed the README gets, since the README does not mount a consumer parser.
  it("answers a malformed body from inside the router even with no app-level errorHandler mounted", async () => {
    const oauth = createShopifyMcpOAuth(buildBaseConfig());
    const app = express();
    app.use(oauth.router);
    // Deliberately no app.use(oauth.errorHandler) and no consumer body-parser.

    const response = await request(app).post("/token").set("Content-Type", "application/json").send("{ not json");

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_request");
    // Express's default handler would have answered an HTML page carrying this.
    expect(response.text).not.toContain("SyntaxError");
  });

  // RFC 6749 §5.2 names /token specifically, and /token is the endpoint whose old answer to this
  // was a 400 the OAuth client could act on. Asserted on its own route rather than folded into the
  // /register case above, because it is the one this regressed.
  it("refuses a malformed /token body with 400 invalid_request, not 500", async () => {
    const response = await request(buildFullyWiredApp())
      .post("/token")
      .set("Content-Type", "application/json")
      .send("{ not json");

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_request");
  });

  // body-parser's other two client statuses reach this handler by exactly the same route, and a
  // fix that special-cased only SyntaxError would leave these as 500s. 413 in particular is the one
  // an operator needs to be able to tell apart from a genuine fault.
  it("answers 413 for a body over the parser's size limit", async () => {
    const response = await request(buildFullyWiredApp())
      .post("/token")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ grant_type: "x".repeat(200_000) }));

    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      error: "invalid_request",
      error_description: "The request body is too large",
    });
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
    const warnLog = vi.fn();
    const errorLog = vi.fn();
    const oauth = createShopifyMcpOAuth(
      buildBaseConfig({ logger: { info: () => {}, warn: warnLog, error: errorLog } })
    );
    const app = express();
    app.use(express.json());
    app.use(oauth.router);
    app.use(oauth.errorHandler);
    warnLog.mockClear(); // resolveConfig's own no-cache warning fires during construction.

    await request(app).post("/register").set("Content-Type", "application/json").send('{"redirect_uris": [invalid');

    // `warn`, not `error`: a body this caller could not encode is not a fault of this server, and
    // /token and the parse step generally are reachable unauthenticated and unrated-limited -- so
    // logging each one at `error` hands an anonymous caller a way to bury real faults under noise.
    expect(warnLog).toHaveBeenCalledTimes(1);
    expect(errorLog).not.toHaveBeenCalled();
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

  // The router-internal mount IS reachable by a real request now that router.ts mounts body parsers
  // on its own routes: a malformed body throws inside the router's stack, so this handler answers
  // it even when the consumer never mounted the app-level one ("answers a malformed body from
  // inside the router..." below drives exactly that). It still also protects what it always did --
  // a future controller that forgets asyncHandler, or a synchronous throw added to
  // requireShopifyHmac/createRateLimiter -- and neither of those can be pinned by sending a
  // request, so this keeps asserting the structural property directly on the router's shape.
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

describe("mounts no rate limiter unless one is configured", () => {
  // The limiter is opt-in (see registerRateLimit / revokeRateLimit in config.ts). These pin the
  // half of that contract a type can't: not "the resolved config says null" but "no 429 comes back
  // and no limiter layer sits in the stack", which is what a consumer actually observes.
  const MORE_REQUESTS_THAN_THE_RECOMMENDED_LIMIT_ALLOWS = RECOMMENDED_RATE_LIMIT.limit + 1;

  function buildUnlimitedApp() {
    const oauth = createShopifyMcpOAuth(buildBaseConfig());
    const app = express();
    app.use(express.json());
    app.use(oauth.router);
    return app;
  }

  it("leaves /register unlimited", async () => {
    const app = buildUnlimitedApp();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < MORE_REQUESTS_THAN_THE_RECOMMENDED_LIMIT_ALLOWS; attempt++) {
      const response = await request(app)
        .post("/register")
        .send({ redirect_uris: [REDIRECT_URI] });
      statuses.push(response.status);
    }
    expect(statuses.every((status) => status === 201)).toBe(true);
  });

  it("leaves /revoke unlimited", async () => {
    const app = buildUnlimitedApp();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < MORE_REQUESTS_THAN_THE_RECOMMENDED_LIMIT_ALLOWS; attempt++) {
      const response = await request(app)
        .post("/revoke")
        .send({ token: `guess-${attempt}` });
      statuses.push(response.status);
    }
    expect(statuses.every((status) => status === 200)).toBe(true);
  });

  it("mounts one fewer layer on /register than a configured limit does", () => {
    // The status assertions above stay green if a limiter is mounted with an enormous limit, or
    // with a `skip` that always returns true -- both would still be a limiter the consumer never
    // asked for, still counting, still holding memory. Comparing the route's layer count against
    // the same route built with a limit is what pins "not mounted at all".
    function countRegisterLayers(config: ShopifyMcpOAuthConfig): number {
      const oauth = createShopifyMcpOAuth(config);
      const stack = (oauth.router as unknown as { stack: Array<{ route?: { path: string; stack: unknown[] } }> }).stack;
      const registerRoute = stack.find((layer) => layer.route?.path === "/register")?.route;
      if (!registerRoute) throw new Error("no /register route found on the router");
      return registerRoute.stack.length;
    }

    const withoutLimiter = countRegisterLayers(buildBaseConfig());
    const withLimiter = countRegisterLayers(buildBaseConfig({ registerRateLimit: RECOMMENDED_RATE_LIMIT }));

    expect(withLimiter - withoutLimiter).toBe(1);
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
