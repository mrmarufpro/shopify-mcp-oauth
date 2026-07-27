import jwt from "jsonwebtoken";
import { z } from "zod";

const outerStatePayloadSchema = z.object({
  clientId: z.string(),
  redirectUri: z.string(),
  clientState: z.string(),
  codeChallenge: z.string(),
  codeChallengeMethod: z.string(),
  resource: z.string(),
  nonce: z.string(),
});

const verifiedOuterStateSchema = outerStatePayloadSchema.extend({
  iat: z.number(),
  exp: z.number(),
});

export type OuterStatePayload = z.infer<typeof outerStatePayloadSchema>;
export type VerifiedOuterState = z.infer<typeof verifiedOuterStateSchema>;

export function signOuterState(payload: OuterStatePayload, secret: string, ttlSeconds: number): string {
  return jwt.sign(payload, secret, { algorithm: "HS256", expiresIn: ttlSeconds });
}

export function verifyOuterState(token: string, secret: string): VerifiedOuterState {
  const verified = jwt.verify(token, secret, { algorithms: ["HS256"] });
  return verifiedOuterStateSchema.parse(verified);
}
