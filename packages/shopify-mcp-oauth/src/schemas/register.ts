import { z } from "zod";
import { validateRedirectUri } from "../services/redirectUri";

export const registerRequestSchema = z.object({
  client_name: z.string().optional(),
  redirect_uris: z
    .array(z.string())
    .min(1, "redirect_uris must contain at least one entry")
    .refine((uris) => uris.every((uri) => validateRedirectUri(uri) === null), {
      message: "redirect_uris contains an unacceptable URI",
    }),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  logo_uri: z.string().optional(),
  client_uri: z.string().optional(),
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;
