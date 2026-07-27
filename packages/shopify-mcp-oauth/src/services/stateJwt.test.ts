import { describe, expect, it } from "vitest";
import { signOuterState, verifyOuterState, type OuterStatePayload } from "./stateJwt";

const SECRET = "test-state-secret-at-least-32-bytes-long";
const CLIENT_ID = "https://client.example/metadata.json";
const REDIRECT_URI = "https://client.example/callback";

const payload: OuterStatePayload = {
  clientId: CLIENT_ID,
  redirectUri: REDIRECT_URI,
  clientState: "client-state-value",
  codeChallenge: "challenge-value",
  codeChallengeMethod: "S256",
  resource: "https://mcp.example.com/mcp",
  nonce: "nonce-value",
};

describe("state JWT", () => {
  it("round-trips the payload", () => {
    const verified = verifyOuterState(signOuterState(payload, SECRET, 600), SECRET);
    expect(verified.clientId).toBe(CLIENT_ID);
    expect(verified.redirectUri).toBe(REDIRECT_URI);
  });

  it("rejects a token signed with a different secret", () => {
    const token = signOuterState(payload, SECRET, 600);
    expect(() => verifyOuterState(token, "a-different-secret-value-entirely")).toThrow();
  });

  it("rejects an expired token", () => {
    const token = signOuterState(payload, SECRET, -1);
    expect(() => verifyOuterState(token, SECRET)).toThrow();
  });

  it("rejects a tampered payload", () => {
    const token = signOuterState(payload, SECRET, 600);
    const [header, , signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload, redirectUri: "https://attacker.example/cb" })).toString(
      "base64url"
    );
    expect(() => verifyOuterState(`${header}.${forged}.${signature}`, SECRET)).toThrow();
  });
});
