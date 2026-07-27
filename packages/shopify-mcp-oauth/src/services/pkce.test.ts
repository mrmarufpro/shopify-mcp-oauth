import { describe, expect, it } from "vitest";
import { verifyS256 } from "./pkce";

// RFC 7636 Appendix B.1 test vector.
const RFC7636_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC7636_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("verifyS256", () => {
  it("accepts the verifier that produced the challenge", () => {
    expect(verifyS256(RFC7636_VERIFIER, RFC7636_CHALLENGE)).toBe(true);
  });

  it("rejects a different verifier", () => {
    expect(verifyS256("not-the-verifier", RFC7636_CHALLENGE)).toBe(false);
  });

  it("rejects an empty verifier", () => {
    expect(verifyS256("", RFC7636_CHALLENGE)).toBe(false);
  });
});
