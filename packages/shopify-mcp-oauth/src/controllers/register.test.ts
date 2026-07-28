import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig, type ResolvedConfig } from "../config";
import { registerController } from "./register";

const REDIRECT_URI = "https://client.example/callback";
const API_SECRET_CANARY = "test-api-secret";
const STATE_SECRET_CANARY = "test-state-secret-at-least-32-bytes-long";

function buildConfig(): ResolvedConfig {
  return resolveConfig({
    host: "https://mcp.example.com",
    shopify: { apiKey: "test-api-key", apiSecret: API_SECRET_CANARY, scopes: "read_products" },
    stateSecret: STATE_SECRET_CANARY,
    storage: memoryStorage(),
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
    expect(response.body.error_description).toBe("redirect_uris must contain at least one entry");
  });

  it("returns a generic 500 without a stack trace when the client store fails", async () => {
    const config = buildConfig();
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
