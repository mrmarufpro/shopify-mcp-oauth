import { z } from "zod";

// RFC 7636 §4.1: code-verifier = 43*128unreserved, unreserved = ALPHA / DIGIT / "-" / "." / "_" / "~".
// This alphabet is wider than code_challenge's base64url charset (see authorize.ts) — verifiers are
// client-generated and the RFC permits "." and "~" here.
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

const authorizationCodeGrantSchema = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string().min(1, "code is required"),
  redirect_uri: z.string().min(1, "redirect_uri is required"),
  client_id: z.string().min(1, "client_id is required"),
  code_verifier: z
    .string()
    .regex(CODE_VERIFIER_PATTERN, "code_verifier must be 43-128 characters of unreserved RFC 7636 characters"),
});

const refreshTokenGrantSchema = z.object({
  grant_type: z.literal("refresh_token"),
  refresh_token: z.string().min(1, "refresh_token is required"),
  client_id: z.string().min(1, "client_id is required"),
  scope: z.string().optional(),
});

export const tokenRequestSchema = z.discriminatedUnion("grant_type", [
  authorizationCodeGrantSchema,
  refreshTokenGrantSchema,
]);

export type AuthorizationCodeGrant = z.infer<typeof authorizationCodeGrantSchema>;
export type RefreshTokenGrant = z.infer<typeof refreshTokenGrantSchema>;
