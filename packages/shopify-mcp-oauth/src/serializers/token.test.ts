import { describe, expect, it } from "vitest";
import type { IssuedTokens } from "../services/tokens";
import { serializeTokenBundle } from "./token";

const ISSUED_TOKENS: IssuedTokens = {
  access_token: "test-access-token",
  refresh_token: "test-refresh-token",
  expires_in: 3600,
  scope: "mcp:*",
  token_type: "Bearer",
};

describe("serializeTokenBundle", () => {
  it("serializes every field of the issued bundle, and nothing else", () => {
    // toEqual on the whole object, not per-field checks: a per-field assertion set would still
    // pass if a field were silently dropped (or an extra one added) as long as every asserted
    // field still matched, which is exactly how this file went untested for so long.
    expect(serializeTokenBundle(ISSUED_TOKENS)).toEqual({
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "mcp:*",
    });
  });

  it("carries the bundle's own scope through, not a hardcoded default", () => {
    const widerScope: IssuedTokens = { ...ISSUED_TOKENS, scope: "admin:* mcp:*" };
    expect(serializeTokenBundle(widerScope).scope).toBe("admin:* mcp:*");
  });
});
