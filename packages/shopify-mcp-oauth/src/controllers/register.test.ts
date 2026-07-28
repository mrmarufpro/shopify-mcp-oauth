import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { memoryStorage } from "../adapters/memoryStorage";
import { resolveConfig } from "../config";
import { registerController } from "./register";

const REDIRECT_URI = "https://client.example/callback";

function buildApp() {
  const config = resolveConfig({
    host: "https://mcp.example.com",
    shopify: { apiKey: "test-api-key", apiSecret: "test-api-secret", scopes: "read_products" },
    stateSecret: "test-state-secret-at-least-32-bytes-long",
    storage: memoryStorage(),
  });
  const app = express();
  app.use(express.json());
  app.post("/register", registerController(config));
  return app;
}

describe("registerController", () => {
  it("returns 201 with a generated client_id", async () => {
    const response = await request(buildApp())
      .post("/register")
      .send({ redirect_uris: [REDIRECT_URI] });
    expect(response.status).toBe(201);
    expect(response.body.client_id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("echoes the registered redirect_uris", async () => {
    const response = await request(buildApp())
      .post("/register")
      .send({ redirect_uris: [REDIRECT_URI] });
    expect(response.body.redirect_uris).toEqual([REDIRECT_URI]);
  });

  it("reports token_endpoint_auth_method none", async () => {
    const response = await request(buildApp())
      .post("/register")
      .send({ redirect_uris: [REDIRECT_URI] });
    expect(response.body.token_endpoint_auth_method).toBe("none");
  });

  it("never returns a client_secret", async () => {
    const response = await request(buildApp())
      .post("/register")
      .send({ redirect_uris: [REDIRECT_URI] });
    expect(response.body.client_secret).toBeUndefined();
  });

  it("rejects a body with no redirect_uris", async () => {
    const response = await request(buildApp()).post("/register").send({ client_name: "No Redirects" });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_client_metadata");
  });

  it("rejects a dangerous redirect_uri scheme", async () => {
    const response = await request(buildApp())
      .post("/register")
      .send({ redirect_uris: ["javascript:alert(1)"] });
    expect(response.status).toBe(400);
  });

  it("serializes only the validation message, never the raw issue object", async () => {
    const response = await request(buildApp()).post("/register").send({ client_name: "No Redirects" });
    expect(typeof response.body.error_description).toBe("string");
  });
});
