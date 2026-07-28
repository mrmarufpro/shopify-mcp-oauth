import { z } from "zod";

const authorizationCodeGrantSchema = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string().min(1, "code is required"),
  redirect_uri: z.string().min(1, "redirect_uri is required"),
  client_id: z.string().min(1, "client_id is required"),
  code_verifier: z.string().min(1, "code_verifier is required"),
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
