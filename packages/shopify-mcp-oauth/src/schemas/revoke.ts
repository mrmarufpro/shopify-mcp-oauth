import { z } from "zod";

export const revokeRequestSchema = z.object({
  token: z.string().min(1, "token is required"),
  token_type_hint: z
    .enum(["access_token", "refresh_token"], { message: "token_type_hint must be access_token or refresh_token" })
    .optional(),
  client_id: z.string().optional(),
});
