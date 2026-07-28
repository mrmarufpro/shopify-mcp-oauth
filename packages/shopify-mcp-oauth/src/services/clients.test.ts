import { describe, expect, it } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig, type ResolvedConfig } from "../config";
import { createDcrClient } from "./clients";

const REDIRECT_URI = "https://client.example/callback";

// Silent by default so the no-cache warning does not spray stderr across every case, matching
// the convention in config.test.ts.
const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function buildConfig(): ResolvedConfig {
  return resolveConfig({
    host: "https://mcp.example.com",
    shopify: { apiKey: "test-api-key", apiSecret: "test-api-secret", scopes: "read_products" },
    stateSecret: "test-state-secret-at-least-32-bytes-long",
    storage: memoryStorage(),
    logger: silentLogger,
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
