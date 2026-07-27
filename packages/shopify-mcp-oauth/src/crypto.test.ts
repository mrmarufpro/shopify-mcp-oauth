import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { randomBase64Url, safeEqual, sha256Base64Url, sha256Hex } from "./crypto";

describe("randomBase64Url", () => {
  it("emits URL-safe characters only", () => {
    expect(randomBase64Url(32)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("does not repeat across calls", () => {
    expect(randomBase64Url(32)).not.toBe(randomBase64Url(32));
  });
});

describe("sha256Hex", () => {
  it("matches node's own digest", () => {
    const input = "hello";
    expect(sha256Hex(input)).toBe(crypto.createHash("sha256").update(input).digest("hex"));
  });
});

describe("sha256Base64Url", () => {
  it("emits the RFC 7636 challenge encoding", () => {
    expect(sha256Base64Url("verifier")).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("safeEqual", () => {
  it("is true for identical strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
  });

  it("is false for different lengths", () => {
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  it("is false for same-length differing strings", () => {
    expect(safeEqual("abc", "abd")).toBe(false);
  });
});
