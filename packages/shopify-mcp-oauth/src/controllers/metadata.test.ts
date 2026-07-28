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
