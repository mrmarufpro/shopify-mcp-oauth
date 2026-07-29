import { describe, expect, it, vi } from "vitest";
import { runWithMcpContext } from "../mcp/context";
import { whoamiTool } from "./whoami";

const DEMO_SHOP = "demo.myshopify.com";
const TOKEN_ID = "token_1";

function callWhoami(shopDomain: string) {
  return runWithMcpContext(
    {
      auth: { shopId: shopDomain, shopDomain, tokenId: TOKEN_ID },
      mcpClient: "claude-code",
      audit: vi.fn().mockResolvedValue(undefined),
    },
    () => whoamiTool.callback({})
  );
}

describe("whoami tool", () => {
  it("is registered under a name a client can call", () => {
    expect(whoamiTool.name).toBe("whoami");
  });

  it("reports the shop the caller authenticated as", async () => {
    const result = await callWhoami(DEMO_SHOP);
    expect(JSON.parse(result.content[0]!.text).shop).toBe(DEMO_SHOP);
  });

  it("reports a different shop for a different caller", async () => {
    const result = await callWhoami("other-store.myshopify.com");
    expect(JSON.parse(result.content[0]!.text).shop).toBe("other-store.myshopify.com");
  });

  it("is annotated read-only so clients can call it without a confirmation prompt", () => {
    expect(whoamiTool.config.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });
});
