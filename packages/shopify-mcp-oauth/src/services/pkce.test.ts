import { describe, expect, it } from "vitest";
import { sha256Base64Url } from "../crypto";
import { verifyS256 } from "./pkce";

const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

describe("verifyS256", () => {
  it("accepts the verifier that produced the challenge", () => {
    expect(verifyS256(VERIFIER, sha256Base64Url(VERIFIER))).toBe(true);
  });

  it("rejects a different verifier", () => {
    expect(verifyS256("not-the-verifier", sha256Base64Url(VERIFIER))).toBe(false);
  });

  it("rejects an empty verifier", () => {
    expect(verifyS256("", sha256Base64Url(VERIFIER))).toBe(false);
  });
});
