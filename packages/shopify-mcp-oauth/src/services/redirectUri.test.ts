import { describe, expect, it } from "vitest";
import { redirectUriMatches, validateRedirectUri } from "./redirectUri";

const HTTPS_CALLBACK = "https://client.example/callback";
const LOOPBACK_CALLBACK = "http://127.0.0.1:8976/callback";
const PRIVATE_SCHEME_CALLBACK = "com.example.app://oauth";

describe("validateRedirectUri", () => {
  it("accepts https", () => {
    expect(validateRedirectUri(HTTPS_CALLBACK)).toBeNull();
  });

  it("accepts http on loopback", () => {
    expect(validateRedirectUri(LOOPBACK_CALLBACK)).toBeNull();
  });

  it("accepts a private-use scheme", () => {
    expect(validateRedirectUri(PRIVATE_SCHEME_CALLBACK)).toBeNull();
  });

  it("rejects http on a public host", () => {
    expect(validateRedirectUri("http://client.example/callback")).toMatch(/loopback/);
  });

  it("rejects javascript: URIs", () => {
    expect(validateRedirectUri("javascript:alert(1)")).toMatch(/not allowed/);
  });

  it("rejects unparseable input", () => {
    expect(validateRedirectUri("not a url")).toMatch(/valid URL/);
  });
});

describe("redirectUriMatches", () => {
  it("matches an identical URI", () => {
    expect(redirectUriMatches(HTTPS_CALLBACK, HTTPS_CALLBACK)).toBe(true);
  });

  it("ignores the port on loopback, per RFC 8252 section 7.3", () => {
    expect(redirectUriMatches("http://127.0.0.1:1234/callback", "http://127.0.0.1:55555/callback")).toBe(true);
  });

  it("does not ignore the port on a public host", () => {
    expect(redirectUriMatches("https://client.example:443/cb", "https://client.example:8443/cb")).toBe(false);
  });

  it("rejects a different path", () => {
    expect(redirectUriMatches(HTTPS_CALLBACK, "https://client.example/other")).toBe(false);
  });

  it("rejects a different host", () => {
    expect(redirectUriMatches(HTTPS_CALLBACK, "https://attacker.example/callback")).toBe(false);
  });
});
