import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index";

describe("package entry", () => {
  it("exposes its own name", () => {
    expect(PACKAGE_NAME).toBe("shopify-mcp-oauth");
  });
});
