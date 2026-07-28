import { z } from "zod";

// S256 is the only accepted method (see code_challenge_method below), and its output is
// deterministic: base64url(SHA-256(verifier)) with no padding is always exactly 43 characters
// from [A-Za-z0-9_-]. Unlike code_verifier's RFC 7636 charset, "." and "~" never appear here.
const S256_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const authorizeQuerySchema = z.object({
  response_type: z.literal("code", { message: "response_type must be 'code'" }),
  client_id: z.string().min(1, "client_id is required"),
  redirect_uri: z.string().min(1, "redirect_uri is required"),
  state: z.string().min(1, "state is required"),
  code_challenge: z.string().regex(S256_CHALLENGE_PATTERN, "code_challenge must be a 43-character S256 challenge"),
  code_challenge_method: z.literal("S256", { message: "code_challenge_method must be S256" }),
  // RFC 8707 says clients MUST send `resource`, but as an AS hosting a single resource we accept
  // its absence and treat it as the canonical one. When present it is exact-matched downstream.
  resource: z.string().optional(),
  scope: z.string().optional(),
});

export type AuthorizeQuery = z.infer<typeof authorizeQuerySchema>;
