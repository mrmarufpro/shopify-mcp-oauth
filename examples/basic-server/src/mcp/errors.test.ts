import { describe, expect, it } from "vitest";
import { ERROR_CODES, McpToolError } from "./errors";

describe("McpToolError", () => {
  it("renders MCP's error shape so the client sees a failure, not a crash", () => {
    const content = new McpToolError(ERROR_CODES.VALIDATION_FAILED, "Input failed schema validation").toContent();

    expect(content.isError).toBe(true);
    expect(content.content).toHaveLength(1);
    expect(content.content[0]!.type).toBe("text");
  });

  it("carries the code and message in the payload the model reads", () => {
    const content = new McpToolError(ERROR_CODES.DOWNSTREAM_ERROR, "upstream timed out").toContent();
    const payload = JSON.parse(content.content[0]!.text);

    expect(payload.code).toBe("DOWNSTREAM_ERROR");
    expect(payload.message).toBe("upstream timed out");
  });

  it("includes details when they are given", () => {
    const content = new McpToolError(ERROR_CODES.VALIDATION_FAILED, "bad input", { field: "message" }).toContent();
    expect(JSON.parse(content.content[0]!.text).details).toEqual({ field: "message" });
  });
});
