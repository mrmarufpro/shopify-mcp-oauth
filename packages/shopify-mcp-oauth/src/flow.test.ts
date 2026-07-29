import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "./adapters/memoryStorage";
import { sha256Base64Url } from "./crypto";
import { createShopifyMcpOAuth } from "./index";
import type { OAuthStorage, Logger } from "./types";

// Every prior test file drives one unit against fakes. This one is the only place that drives the
// whole login end to end through a real, fully-wired app -- discovery, /register, /authorize, the
// Shopify callback, /token, and requireAuth -- with only the Shopify side stubbed. It exists to
// catch a mismatch between two units that each pass their own tests in isolation.

const HOST = "https://mcp.example.com";
const SHOPIFY_API_KEY = "test-api-key";
const API_SECRET = "test-api-secret";
const DEMO_SHOP = "demo.myshopify.com";
const DEMO_SHOP_ID = "shop_1";
const REDIRECT_URI = "https://client.example/callback";
const CLIENT_STATE = "client-state-value";
const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
// Shopify's own admin host -- fixed in authorize.ts, not something this package's config can
// override. See authorizeAndGetShopifyState below for why this is checked as an origin, not just
// decoded out of the redirect target.
const SHOPIFY_ADMIN_ORIGIN = "https://admin.shopify.com";

// Silent by default, matching every other test file in this package -- the no-cache-configured
// warning resolveConfig logs on every createShopifyMcpOAuth call would otherwise spray stderr
// across a suite this size.
const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function shopifyExchangeResponse(): Response {
  return new Response(JSON.stringify({ access_token: "shpua_exchanged_token" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

interface BuildAppOptions {
  storage?: OAuthStorage;
  fetchImpl?: ReturnType<typeof vi.fn>;
}

// Mounts oauth.errorHandler LAST, at the top level, after the consumer's own body-parsers and
// after oauth.router -- the one placement index.ts's own doc comment says is load-bearing. Every
// test in this file goes through a genuine, adopter-shaped wiring, not a bare app.use(oauth.router).
// See "the errorHandler mount this file's buildApp includes is not decorative" below for the test
// that actually proves this mount does something, rather than just commenting that it should.
function buildApp(options: BuildAppOptions = {}) {
  // mockImplementation, not mockResolvedValue: a Response body is a single-use stream, and
  // mockResolvedValue would hand back the SAME Response instance on every call. That's invisible
  // in a test that only ever completes one flow per app, but this file's two-shop test drives two
  // full flows through one shared fetchImpl -- the second callback's `exchange.json()` would find
  // the body already consumed by the first and silently 400 with "no access token". A fresh
  // Response per call is what makes fetchImpl safely reusable across an arbitrary number of flows.
  const fetchImpl = options.fetchImpl ?? vi.fn().mockImplementation(() => shopifyExchangeResponse());
  const oauth = createShopifyMcpOAuth({
    host: HOST,
    shopify: { apiKey: SHOPIFY_API_KEY, apiSecret: API_SECRET, scopes: "read_products" },
    stateSecret: "test-state-secret-at-least-32-bytes-long",
    storage: options.storage ?? memoryStorage({ shops: [{ id: DEMO_SHOP_ID, domain: DEMO_SHOP }] }),
    logger: silentLogger,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(oauth.router);
  app.post("/mcp", oauth.requireAuth, (req, res) => res.status(200).json({ shop: req.mcp?.shopDomain }));
  app.use(oauth.errorHandler);
  return { app, fetchImpl };
}

// Shopify signs the SORTED query string (see middlewares/verifyShopifyHmac.ts) -- building the
// message straight off Object.entries' insertion order signs a different string than the one
// verifyShopifyHmac recomputes, and every callback below would 400 at the HMAC gate before ever
// reaching a controller. Mirrors router.test.ts's own signQuery for exactly this reason.
function signShopifyCallback(params: Record<string, string>): string {
  const sortedEntries = Object.entries(params).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const message = new URLSearchParams(sortedEntries).toString();
  const hmac = crypto.createHmac("sha256", API_SECRET).update(message).digest("hex");
  return `${message}&hmac=${hmac}`;
}

// supertest types header values as `string | undefined` (a response need not carry any given
// header) even though every redirect this file drives always sends one -- coalescing here once,
// the same way authorize.test.ts and shopifyCallback.test.ts already do, is what lets every call
// site below hand a plain `string` to `new URL(...)` instead of repeating the `?? ""` fallback.
function redirectLocation(response: request.Response): string {
  return response.headers.location ?? "";
}

async function registerClient(
  app: ReturnType<typeof express>,
  redirectUri: string,
  path = "/register"
): Promise<{ clientId: string; redirectUri: string }> {
  const response = await request(app)
    .post(path)
    .send({ client_name: "Flow Test Client", redirect_uris: [redirectUri] });
  expect(response.status).toBe(201);
  // Threaded downstream, not re-supplied: every /authorize and /token call below uses the URI
  // /register actually echoed back in its response body, not the literal this function was called
  // with. /authorize's own redirectUriMatches check separately guards against a genuinely wrong
  // STORED value, but nothing checks the response body itself was honest -- a
  // serializeClientRegistration bug that silently mangled or dropped it would otherwise pass unnoticed.
  return { clientId: response.body.client_id as string, redirectUri: response.body.redirect_uris?.[0] as string };
}

// Drives a real /authorize request and hands back the outer state JWT it minted for the Shopify
// leg -- the same JWT admin.shopify.com would replay onto /oauth/shopify-callback once the
// merchant picks a shop. Every caller below uses this real, server-minted state rather than
// calling services/stateJwt.ts directly, so a bug in how authorize.ts builds that state can't hide
// behind a hand-built stand-in.
async function authorizeAndGetShopifyState(
  app: ReturnType<typeof express>,
  input: { clientId: string; redirectUri: string; clientState: string; codeVerifier: string },
  path = "/authorize"
): Promise<string> {
  const response = await request(app)
    .get(path)
    .query({
      response_type: "code",
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      state: input.clientState,
      code_challenge: sha256Base64Url(input.codeVerifier),
      code_challenge_method: "S256",
    });
  expect(response.status).toBe(302);
  const shopPickerUrl = new URL(redirectLocation(response));
  // Checked as an ORIGIN, not just decoded out of the `redirect` param below -- a redirect to
  // https://not-shopify.example/?redirect=<the same valid-looking query> would otherwise pass this
  // helper, since nothing previously looked at where the redirect actually points.
  expect(shopPickerUrl.origin).toBe(SHOPIFY_ADMIN_ORIGIN);
  const shopPickerRedirect = shopPickerUrl.searchParams.get("redirect") ?? "";
  return new URLSearchParams(shopPickerRedirect.split("?")[1]).get("state") ?? "";
}

describe("full authorization flow", () => {
  it("carries a client from registration to an authenticated MCP call, driven by the server's own discovery document", async () => {
    const { app, fetchImpl } = buildApp();

    // A well-behaved client discovers its endpoints instead of hardcoding them. Reading them off
    // the response -- rather than asserting equality against literal strings, which
    // serializers/metadata.test.ts already does thoroughly -- is what makes this catch a served
    // endpoint that LOOKS right in the JSON but doesn't actually resolve to a working route, a
    // mismatch no unit test of the serializer alone could ever observe.
    const discovery = await request(app).get("/.well-known/oauth-authorization-server");
    expect(discovery.status).toBe(200);
    expect(discovery.body.issuer).toBe(HOST);
    const registrationPath = new URL(discovery.body.registration_endpoint).pathname;
    const authorizePath = new URL(discovery.body.authorization_endpoint).pathname;
    const tokenPath = new URL(discovery.body.token_endpoint).pathname;
    const revokePath = new URL(discovery.body.revocation_endpoint).pathname;

    const protectedResource = await request(app).get("/.well-known/oauth-protected-resource");
    expect(protectedResource.status).toBe(200);
    expect(protectedResource.body.resource).toBe(`${HOST}/mcp`);

    const { clientId, redirectUri } = await registerClient(app, REDIRECT_URI, registrationPath);
    const stateJwt = await authorizeAndGetShopifyState(
      app,
      { clientId, redirectUri, clientState: CLIENT_STATE, codeVerifier: CODE_VERIFIER },
      authorizePath
    );

    const callbackQuery = signShopifyCallback({ shop: DEMO_SHOP, code: "shopify-code", state: stateJwt });
    const callback = await request(app).get(`/oauth/shopify-callback?${callbackQuery}`);
    expect(callback.status).toBe(302);
    // fetchImpl is only ever called from inside shopifyCallbackController, once the HMAC guard and
    // state verification both succeed -- this is what proves the request actually got that far.
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // The single call that proves the merchant actually authorised THIS app for THIS shop -- a
    // stub that swallowed the request and returned success regardless of what was sent would be
    // indistinguishable from a real one without checking what actually went out on the wire.
    const [exchangeUrl, exchangeInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(exchangeUrl).toBe(`https://${DEMO_SHOP}/admin/oauth/access_token`);
    expect(JSON.parse(exchangeInit.body as string)).toEqual({
      client_id: SHOPIFY_API_KEY,
      client_secret: API_SECRET,
      code: "shopify-code",
    });

    const callbackRedirect = new URL(redirectLocation(callback));
    const authorizationCode = callbackRedirect.searchParams.get("code") ?? "";
    expect(callbackRedirect.searchParams.get("state")).toBe(CLIENT_STATE);
    // The redirect must land on the CLIENT's own redirect_uri, not merely some URL carrying a code
    // and state -- a client-supplied redirect_uri silently ignored would still pass a status-only check.
    expect(`${callbackRedirect.origin}${callbackRedirect.pathname}`).toBe(redirectUri);

    const tokenResponse = await request(app).post(tokenPath).type("form").send({
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: CODE_VERIFIER,
    });
    expect(tokenResponse.status).toBe(200);
    expect(tokenResponse.body.token_type).toBe("Bearer");

    const call = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${tokenResponse.body.access_token}`)
      .send({});
    expect(call.status).toBe(200);
    expect(call.body.shop).toBe(DEMO_SHOP);

    // The code minted by the callback must be single-use: redeeming the EXACT SAME code again,
    // with every parameter still correct, must fail now that /token above already consumed it --
    // "fails when a parameter is wrong" (already covered by controllers/token.test.ts) can't tell
    // that apart from a cache that never deletes what it read.
    const replay = await request(app).post(tokenPath).type("form").send({
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: CODE_VERIFIER,
    });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
    // error alone is shared by five different rejection branches in tokenController -- the
    // description is what actually pins this as "already consumed", not e.g. a client_id or
    // redirect_uri mismatch that would coincidentally produce the same error code.
    expect(replay.body.error_description).toBe("code unknown, expired, or already used");

    const refreshed = await request(app).post(tokenPath).type("form").send({
      grant_type: "refresh_token",
      refresh_token: tokenResponse.body.refresh_token,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
    // A rotated token must be a genuinely DIFFERENT credential, not the original echoed back --
    // otherwise the revoke-then-block assertions below could pass even if rotation never ran.
    expect(refreshed.body.access_token).not.toBe(tokenResponse.body.access_token);

    // Rotation must actually revoke the PRE-rotation access token, not just mint a new one
    // alongside it -- proven here independently of the explicit /revoke call further down, which
    // only ever exercises the refreshed (post-rotation) token and so can't tell these apart.
    const originalTokenAfterRotation = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${tokenResponse.body.access_token}`)
      .send({});
    expect(originalTokenAfterRotation.status).toBe(401);

    // Proven usable BEFORE revocation, so "blocked" below is known to mean "revoked", not
    // "was never a real token to begin with".
    const stillWorks = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${refreshed.body.access_token}`)
      .send({});
    expect(stillWorks.status).toBe(200);
    expect(stillWorks.body.shop).toBe(DEMO_SHOP);

    const afterRevoke = await request(app).post(revokePath).send({ token: refreshed.body.access_token });
    expect(afterRevoke.status).toBe(200);

    const blocked = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${refreshed.body.access_token}`)
      .send({});
    expect(blocked.status).toBe(401);

    // Threaded, not hardcoded: re-fetching the exact URL the 401 points at proves it's a genuinely
    // working pointer to the real protected-resource document, not merely a string that happens to
    // look right -- a status-only or literal-equality check on the header can't tell those apart.
    const wwwAuthenticate = blocked.headers["www-authenticate"] ?? "";
    expect(wwwAuthenticate).toContain('error="invalid_token"');
    const resourceMetadataUrl = /resource_metadata="([^"]+)"/.exec(wwwAuthenticate)?.[1] ?? "";
    const rediscoveredResource = await request(app).get(new URL(resourceMetadataUrl).pathname);
    expect(rediscoveredResource.status).toBe(200);
    expect(rediscoveredResource.body.resource).toBe(`${HOST}/mcp`);
  });

  it("stops an uninstalled shop at the callback, before any authorization code is issued", async () => {
    const { app, fetchImpl } = buildApp({ storage: memoryStorage() });

    const { clientId, redirectUri } = await registerClient(app, REDIRECT_URI);
    const stateJwt = await authorizeAndGetShopifyState(app, {
      clientId,
      redirectUri,
      clientState: CLIENT_STATE,
      codeVerifier: CODE_VERIFIER,
    });

    const callbackQuery = signShopifyCallback({ shop: DEMO_SHOP, code: "shopify-code", state: stateJwt });
    const callback = await request(app).get(`/oauth/shopify-callback?${callbackQuery}`);

    expect(callback.status).toBe(403);
    expect(callback.text).toContain(DEMO_SHOP);
    // The Shopify token exchange still has to run before the install check can (it's what proves
    // the merchant controls the shop) -- but nothing past it should. Asserting it ran exactly
    // once, not "not called", is what tells this apart from the HMAC/state gates rejecting first
    // for an unrelated reason.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("the errorHandler mount this file's buildApp includes is not decorative", () => {
  // Every other test in this file goes through buildApp's full, adopter-shaped wiring -- body
  // parsers, oauth.router, and oauth.errorHandler mounted last -- and the comment on that mount
  // calls the placement "load-bearing". Nothing else in this file ever sends a request malformed
  // enough to exercise it, so without this test that mount is decorative from this file's own
  // point of view: router.test.ts proves the two-mount design in its own, separately-built fixture,
  // but that can't stand in for proving THIS file's own app actually needs the line it has.
  it("converts a malformed JSON body sent through the full flow's own app into the generic safe shape, not Express's default HTML stack trace", async () => {
    const { app } = buildApp();

    const response = await request(app)
      .post("/register")
      .set("Content-Type", "application/json")
      .send('{"redirect_uris": [invalid');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "server_error", error_description: "An unexpected error occurred" });
    // "a caught error's .message must never reach a response body" -- checked directly, not just
    // inferred from the generic body matching: a handler that logged the real message but still
    // happened to answer with the generic shape would pass the assertion above.
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain("SyntaxError");
    expect(raw).not.toContain(".ts:");
  });
});

describe("two shops stay distinct across independent flows", () => {
  const SHOP_A = "shop-a.myshopify.com";
  const SHOP_A_ID = "shop_a";
  const SHOP_B = "shop-b.myshopify.com";
  const SHOP_B_ID = "shop_b";

  it("reports each shop's own identity to the resource server, never the other shop's", async () => {
    const { app, fetchImpl } = buildApp({
      storage: memoryStorage({
        shops: [
          { id: SHOP_A_ID, domain: SHOP_A },
          { id: SHOP_B_ID, domain: SHOP_B },
        ],
      }),
    });
    const { clientId, redirectUri } = await registerClient(app, REDIRECT_URI);

    async function completeFlowFor(shop: string, clientState: string, codeVerifier: string): Promise<string> {
      const stateJwt = await authorizeAndGetShopifyState(app, { clientId, redirectUri, clientState, codeVerifier });
      const callbackQuery = signShopifyCallback({ shop, code: `shopify-code-for-${shop}`, state: stateJwt });
      const callback = await request(app).get(`/oauth/shopify-callback?${callbackQuery}`);
      expect(callback.status).toBe(302);

      // Each shop's own callback must send ITS OWN shop and code to Shopify -- not, say, the
      // first shop's, left over from a previous flow sharing the same fetchImpl. Checked against
      // the LATEST call, not calls[0], since this runs once per shop on a shared spy.
      const latestCall = fetchImpl.mock.calls.at(-1) as [string, RequestInit];
      expect(latestCall[0]).toBe(`https://${shop}/admin/oauth/access_token`);
      expect(JSON.parse(latestCall[1].body as string).code).toBe(`shopify-code-for-${shop}`);

      const authorizationCode = new URL(redirectLocation(callback)).searchParams.get("code") ?? "";
      const tokenResponse = await request(app).post("/token").type("form").send({
        grant_type: "authorization_code",
        code: authorizationCode,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: codeVerifier,
      });
      expect(tokenResponse.status).toBe(200);
      return tokenResponse.body.access_token as string;
    }

    // Two distinct PKCE verifiers and client states so each flow's own trail is unambiguous below
    // -- reusing one verifier for both would still work (each /authorize call derives its own
    // code_challenge from it independently) but would make the two runs harder to tell apart.
    const tokenForShopA = await completeFlowFor(SHOP_A, "client-state-a", "a".repeat(43));
    const tokenForShopB = await completeFlowFor(SHOP_B, "client-state-b", "b".repeat(43));

    const callAsShopA = await request(app).post("/mcp").set("Authorization", `Bearer ${tokenForShopA}`).send({});
    const callAsShopB = await request(app).post("/mcp").set("Authorization", `Bearer ${tokenForShopB}`).send({});

    expect(callAsShopA.status).toBe(200);
    expect(callAsShopB.status).toBe(200);
    expect(callAsShopA.body.shop).toBe(SHOP_A);
    expect(callAsShopB.body.shop).toBe(SHOP_B);
  });
});

describe("the shopify callback rejects a forged HMAC even when the state it carries is genuine", () => {
  it("never reaches the controller when a real /authorize-minted state is paired with a bad hmac", async () => {
    const fetchImpl = vi.fn();
    const { app } = buildApp({ fetchImpl });

    const { clientId, redirectUri } = await registerClient(app, REDIRECT_URI);
    const stateJwt = await authorizeAndGetShopifyState(app, {
      clientId,
      redirectUri,
      clientState: CLIENT_STATE,
      codeVerifier: CODE_VERIFIER,
    });

    // Everything here is genuine except the signature itself: a real client_id this app just
    // registered, a real state this app's own /authorize minted moments ago. Only the hmac is forged.
    const forgedQuery = `${new URLSearchParams({
      shop: DEMO_SHOP,
      code: "shopify-code",
      state: stateJwt,
    }).toString()}&hmac=${"0".repeat(64)}`;
    const callback = await request(app).get(`/oauth/shopify-callback?${forgedQuery}`);

    expect(callback.status).toBe(400);
    // fetchImpl is only ever called from inside shopifyCallbackController -- it staying uncalled
    // proves requireShopifyHmac rejected this before the controller ever ran, not that the
    // controller ran and failed downstream for some unrelated reason.
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
