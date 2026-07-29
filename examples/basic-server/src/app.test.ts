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
    fetchImpl: vi.fn().mockImplementation(
      () =>
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

function redirectLocation(response: request.Response): string {
  return response.headers.location ?? "";
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

  const shopifyRedirect = new URL(redirectLocation(authorize)).searchParams.get("redirect") ?? "";
  const stateJwt = new URLSearchParams(shopifyRedirect.split("?")[1]).get("state") ?? "";

  const callback = await request(app).get(
    `/oauth/shopify-callback?${signShopifyCallback({ shop: shopDomain, code: "shopify-code", state: stateJwt })}`
  );
  const authorizationCode = new URL(redirectLocation(callback)).searchParams.get("code") ?? "";

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

    const shopifyRedirect = new URL(redirectLocation(authorize)).searchParams.get("redirect") ?? "";
    const stateJwt = new URLSearchParams(shopifyRedirect.split("?")[1]).get("state") ?? "";
    const callback = await request(app).get(
      `/oauth/shopify-callback?${signShopifyCallback({
        shop: UNINSTALLED_SHOP,
        code: "shopify-code",
        state: stateJwt,
      })}`
    );

    expect(callback.status).toBe(403);
    expect(callback.text).toContain("has not installed this app");
  });

  it("answers 405 on GET /mcp so a browser gets a clear error", async () => {
    const response = await request(buildApp()).get("/mcp");
    expect(response.status).toBe(405);
  });
});
