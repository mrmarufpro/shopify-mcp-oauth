import { describe, expect, it, vi } from "vitest";
import { runWithMcpContext } from "../mcp/context";
import { ERROR_CODES } from "../mcp/errors";
import { echoTool } from "./echo";

const DEMO_SHOP = "demo.myshopify.com";

function callEcho(input: unknown) {
  return runWithMcpContext(
    {
      auth: { shopId: DEMO_SHOP, shopDomain: DEMO_SHOP, tokenId: "token_1" },
      mcpClient: "claude-code",
      audit: vi.fn().mockResolvedValue(undefined),
    },
    () => echoTool.callback(input)
  );
}

describe("echo tool", () => {
  it("returns the message it was given", async () => {
    const result = await callEcho({ message: "hello from the merchant" });
    expect(JSON.parse(result.content[0]!.text).message).toBe("hello from the merchant");
  });

  it("rejects an empty message through the shared validation path", async () => {
    const result = await callEcho({ message: "" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });

  it("rejects a missing message", async () => {
    const result = await callEcho({});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });
});
