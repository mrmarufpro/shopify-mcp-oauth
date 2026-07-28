import { z } from "zod";
import { validateRedirectUri } from "../services/redirectUri";
import { capOversizedArray } from "./capOversizedArray";

// This body is reachable directly from an unauthenticated client's POST /register — bound its
// worst case here rather than depending on a body-size limit owned by a different layer. Limits
// are generous for any real client (a handful of redirect URIs, short display metadata) while
// still capping the cost of validating a maliciously large payload.
export const REGISTER_MAX_REDIRECT_URIS = 20;
export const REGISTER_MAX_URI_LENGTH = 2048;
export const REGISTER_MAX_GRANT_TYPES = 10;
export const REGISTER_MAX_RESPONSE_TYPES = 10;
export const REGISTER_MAX_CLIENT_NAME_LENGTH = 200;

export const registerRequestSchema = z.object({
  client_name: z.string().max(REGISTER_MAX_CLIENT_NAME_LENGTH, "client_name is too long").optional(),
  redirect_uris: z.preprocess(
    // Defaulting the missing key to [] here (rather than a `required_error` on z.array) keeps
    // this message the same across zod majors — zod 4 ignores required_error/invalid_type_error
    // in favor of a single `error` param, so required_error alone would only fire this message
    // under zod 3.
    (value) => capOversizedArray(value ?? [], REGISTER_MAX_REDIRECT_URIS),
    z
      .array(z.string().max(REGISTER_MAX_URI_LENGTH, "redirect_uris entry is too long"))
      .min(1, "redirect_uris must contain at least one entry")
      .max(REGISTER_MAX_REDIRECT_URIS, "redirect_uris has too many entries")
      .refine(
        (uris) => uris.length > REGISTER_MAX_REDIRECT_URIS || uris.every((uri) => validateRedirectUri(uri) === null),
        { message: "redirect_uris contains an unacceptable URI" }
      )
  ),
  grant_types: z
    .preprocess(
      (value) => capOversizedArray(value, REGISTER_MAX_GRANT_TYPES),
      z.array(z.string()).max(REGISTER_MAX_GRANT_TYPES, "grant_types has too many entries")
    )
    .optional(),
  response_types: z
    .preprocess(
      (value) => capOversizedArray(value, REGISTER_MAX_RESPONSE_TYPES),
      z.array(z.string()).max(REGISTER_MAX_RESPONSE_TYPES, "response_types has too many entries")
    )
    .optional(),
  logo_uri: z.string().max(REGISTER_MAX_URI_LENGTH, "logo_uri is too long").optional(),
  client_uri: z.string().max(REGISTER_MAX_URI_LENGTH, "client_uri is too long").optional(),
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;
