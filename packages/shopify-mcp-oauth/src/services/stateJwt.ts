import jwt from "jsonwebtoken";

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

export function signOuterState(payload: OuterStatePayload, secret: string, ttlSeconds: number): string {
  return jwt.sign(payload, secret, { algorithm: "HS256", expiresIn: ttlSeconds });
}

export function verifyOuterState(token: string, secret: string): VerifiedOuterState {
  return jwt.verify(token, secret, { algorithms: ["HS256"] }) as VerifiedOuterState;
}
