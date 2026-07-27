import { describe, expect, it } from "vitest";
import { OAuthError } from "./errors";

const INVALID_GRANT = "invalid_grant";

describe("OAuthError", () => {
  it("defaults to HTTP 400", () => {
    const error = new OAuthError(INVALID_GRANT, "code already used");
    expect(error.status).toBe(400);
  });

  it("serializes to the RFC 6749 error body", () => {
    const error = new OAuthError(INVALID_GRANT, "code already used");
    expect(error.toBody()).toEqual({ error: INVALID_GRANT, error_description: "code already used" });
  });

  it("carries an explicit status when given one", () => {
    const error = new OAuthError("shop_not_installed", "Install the app first.", 403);
    expect(error.status).toBe(403);
  });
});
