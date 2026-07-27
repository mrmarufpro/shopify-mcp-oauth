import { describe, expect, it } from "vitest";
import { redirectUriMatches, validateRedirectUri } from "./redirectUri";

const HTTPS_CALLBACK = "https://client.example/callback";
const LOOPBACK_CALLBACK = "http://127.0.0.1:8976/callback";
const PRIVATE_SCHEME_CALLBACK = "com.example.app://oauth";
const REGISTERED_HTTPS = "https://good.example.com/cb";
const SUFFIX_ATTACK = "https://good.example.com.evil.test/cb";
const USERINFO_WITH_USER = "https://attacker@client.example/callback";
const USERINFO_WITH_PASS = "https://user:password@client.example/callback";
const LOOPBACK_VARIANT = "http://127.0.0.5:8976/callback";

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

  it("rejects userinfo (username)", () => {
    expect(validateRedirectUri(USERINFO_WITH_USER)).toMatch(/userinfo/);
  });

  it("rejects userinfo (username:password)", () => {
    expect(validateRedirectUri(USERINFO_WITH_PASS)).toMatch(/userinfo/);
  });

  it("accepts loopback address 127.0.0.5", () => {
    expect(validateRedirectUri(LOOPBACK_VARIANT)).toBeNull();
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

  it("rejects suffix confusion attack (attacker.com.evil.test)", () => {
    expect(redirectUriMatches(REGISTERED_HTTPS, SUFFIX_ATTACK)).toBe(false);
  });

  it("rejects userinfo injection (username)", () => {
    expect(redirectUriMatches(HTTPS_CALLBACK, USERINFO_WITH_USER)).toBe(false);
  });

  it("rejects userinfo injection (username:password)", () => {
    expect(redirectUriMatches(HTTPS_CALLBACK, USERINFO_WITH_PASS)).toBe(false);
  });

  it("ignores port on extended loopback range (127.0.0.5)", () => {
    expect(redirectUriMatches("http://127.0.0.5:1234/callback", "http://127.0.0.5:5678/callback")).toBe(true);
  });
});
