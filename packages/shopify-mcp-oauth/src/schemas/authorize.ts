import { z } from "zod";

export const authorizeQuerySchema = z.object({
  response_type: z.literal("code", { message: "response_type must be 'code'" }),
  client_id: z.string().min(1, "client_id is required"),
  redirect_uri: z.string().min(1, "redirect_uri is required"),
  state: z.string().min(1, "state is required"),
  code_challenge: z.string().min(1, "code_challenge is required"),
  code_challenge_method: z.literal("S256", { message: "code_challenge_method must be S256" }),
  // RFC 8707 says clients MUST send `resource`, but as an AS hosting a single resource we accept
  // its absence and treat it as the canonical one. When present it is exact-matched downstream.
  resource: z.string().optional(),
  scope: z.string().optional(),
});

export type AuthorizeQuery = z.infer<typeof authorizeQuerySchema>;
