import jwt from "jsonwebtoken";
import { z } from "zod";

export interface OuterStatePayload {
  clientId: string;
  redirectUri: string;
  clientState: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string;
  nonce: string;
}

export interface VerifiedOuterState extends OuterStatePayload {
  iat: number;
  exp: number;
}

const verifiedOuterStateSchema = z.object({
  clientId: z.string(),
  redirectUri: z.string(),
  clientState: z.string(),
  codeChallenge: z.string(),
  codeChallengeMethod: z.string(),
  resource: z.string(),
  nonce: z.string(),
  iat: z.number(),
  exp: z.number(),
});

export function signOuterState(payload: OuterStatePayload, secret: string, ttlSeconds: number): string {
  return jwt.sign(payload, secret, { algorithm: "HS256", expiresIn: ttlSeconds });
}

export function verifyOuterState(token: string, secret: string): VerifiedOuterState {
  const verified = jwt.verify(token, secret, { algorithms: ["HS256"] });
  return verifiedOuterStateSchema.parse(verified);
}
