import { describe, expect, it, vi } from "vitest";
import { getMcpContext, runWithMcpContext, type McpRequestContext } from "./context";

const FIRST_SHOP = "first-store.myshopify.com";
const SECOND_SHOP = "second-store.myshopify.com";

function buildContext(shopDomain: string): McpRequestContext {
  return {
    auth: { shopId: shopDomain, shopDomain, tokenId: `token_${shopDomain}` },
    mcpClient: "claude-code",
    audit: vi.fn().mockResolvedValue(undefined),
  };
}

describe("mcp request context", () => {
  it("is null outside a request", () => {
    expect(getMcpContext()).toBeNull();
  });

  it("is visible to code running inside the request", async () => {
    await runWithMcpContext(buildContext(FIRST_SHOP), async () => {
      expect(getMcpContext()?.auth.shopDomain).toBe(FIRST_SHOP);
    });
  });

  it("survives an await boundary", async () => {
    await runWithMcpContext(buildContext(FIRST_SHOP), async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(getMcpContext()?.auth.shopDomain).toBe(FIRST_SHOP);
    });
  });

  it("keeps concurrent requests from seeing each other's shop", async () => {
    const observed: string[] = [];

    await Promise.all([
      runWithMcpContext(buildContext(FIRST_SHOP), async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        observed.push(getMcpContext()!.auth.shopDomain);
      }),
      runWithMcpContext(buildContext(SECOND_SHOP), async () => {
        observed.push(getMcpContext()!.auth.shopDomain);
      }),
    ]);

    expect(observed.sort()).toEqual([FIRST_SHOP, SECOND_SHOP].sort());
  });

  it("is null again after the request finishes", async () => {
    await runWithMcpContext(buildContext(FIRST_SHOP), async () => undefined);
    expect(getMcpContext()).toBeNull();
  });
});
