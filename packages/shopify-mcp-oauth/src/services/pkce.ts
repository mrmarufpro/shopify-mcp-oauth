import { safeEqual, sha256Base64Url } from "../crypto";

export function verifyS256(verifier: string, expectedChallenge: string): boolean {
  if (!verifier) return false;
  return safeEqual(sha256Base64Url(verifier), expectedChallenge);
}
