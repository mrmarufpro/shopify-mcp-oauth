import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const VALID_ENVIRONMENT = {
  MCP_HOST: "https://mcp.example.com",
  SHOPIFY_API_KEY: "test-api-key",
  SHOPIFY_API_SECRET: "test-api-secret",
  SHOPIFY_SCOPES: "read_products",
  OAUTH_STATE_SECRET: "test-state-secret-at-least-32-bytes-long",
};

describe("loadConfig", () => {
  it("reads the Shopify credentials through", () => {
    const config = loadConfig({ ...VALID_ENVIRONMENT, SHOPIFY_SCOPES: "read_products,write_products" });
    expect(config.shopify).toEqual({
      apiKey: "test-api-key",
      apiSecret: "test-api-secret",
      scopes: "read_products,write_products",
    });
  });

  it("defaults the port to 3000", () => {
    expect(loadConfig(VALID_ENVIRONMENT).port).toBe(3000);
  });

  it("reads a port from the environment", () => {
    expect(loadConfig({ ...VALID_ENVIRONMENT, PORT: "4001" }).port).toBe(4001);
  });

  it("strips a trailing slash so issued URLs never double up", () => {
    const config = loadConfig({ ...VALID_ENVIRONMENT, MCP_HOST: "https://mcp.example.com/" });
    expect(config.host).toBe("https://mcp.example.com");
  });

  it("defaults the demo shop domain", () => {
    expect(loadConfig(VALID_ENVIRONMENT).demoShopDomain).toBe("demo.myshopify.com");
  });

  it("reads a demo shop domain from the environment", () => {
    const config = loadConfig({ ...VALID_ENVIRONMENT, DEMO_SHOP_DOMAIN: "other-store.myshopify.com" });
    expect(config.demoShopDomain).toBe("other-store.myshopify.com");
  });

  it("names the missing variable when a required one is absent", () => {
    const { SHOPIFY_API_SECRET: _absent, ...withoutSecret } = VALID_ENVIRONMENT;
    expect(() => loadConfig(withoutSecret)).toThrow(/SHOPIFY_API_SECRET/);
  });

  it("rejects a state secret shorter than 32 characters", () => {
    expect(() => loadConfig({ ...VALID_ENVIRONMENT, OAUTH_STATE_SECRET: "too-short" })).toThrow(/OAUTH_STATE_SECRET/);
  });

  it("rejects a host that is not a URL", () => {
    expect(() => loadConfig({ ...VALID_ENVIRONMENT, MCP_HOST: "mcp.example.com" })).toThrow(/MCP_HOST/);
  });
});
