import { describe, expect, it } from "vitest";
import { classifyClient, UNKNOWN_CLIENT_MAX_LENGTH } from "./clientName";

describe("classifyClient", () => {
  it("names a known client from its user-agent prefix", () => {
    expect(classifyClient("claude-code/2.1.0 (external, cli)")).toBe("claude-code");
  });

  it("reads the first value when the header arrives repeated", () => {
    expect(classifyClient(["cursor/1.4.2", "something-else"])).toBe("cursor");
  });

  it("falls back to unknown when no user-agent was sent", () => {
    expect(classifyClient(undefined)).toBe("unknown");
  });

  it("truncates an unrecognized user-agent so a hostile header cannot bloat the log", () => {
    const longAgent = "x".repeat(UNKNOWN_CLIENT_MAX_LENGTH + 50);
    expect(classifyClient(longAgent)).toHaveLength(UNKNOWN_CLIENT_MAX_LENGTH);
  });
});
