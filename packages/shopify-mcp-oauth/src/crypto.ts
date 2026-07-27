import crypto from "node:crypto";

function toBase64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function randomBase64Url(bytes: number): string {
  return toBase64Url(crypto.randomBytes(bytes));
}

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function sha256Base64Url(input: string): string {
  return toBase64Url(crypto.createHash("sha256").update(input).digest());
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
