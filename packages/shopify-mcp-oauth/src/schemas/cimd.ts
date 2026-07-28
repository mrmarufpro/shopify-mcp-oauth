import { z } from "zod";
import { validateRedirectUri } from "../services/redirectUri";
import { capOversizedArray } from "./capOversizedArray";

// This document is fetched from a URL the client controls — hostile input. Bound its worst case
// here rather than depending on a fetch layer's byte cap owned by a different task: that cap could
// be loosened, bypassed by a different call site, or this schema reused without it.
export const CIMD_MAX_REDIRECT_URIS = 20;
export const CIMD_MAX_URI_LENGTH = 2048;
export const CIMD_MAX_GRANT_TYPES = 10;
export const CIMD_MAX_RESPONSE_TYPES = 10;
export const CIMD_MAX_CLIENT_NAME_LENGTH = 200;

export const cimdDocumentSchema = z.object({
  client_id: z.string().max(CIMD_MAX_URI_LENGTH, "client_id is too long").optional(),
  client_name: z.string().max(CIMD_MAX_CLIENT_NAME_LENGTH, "client_name is too long").optional(),
  // A CIMD document is fetched from a URL the client controls, exactly like a DCR request body —
  // it gets the same validateRedirectUri check register.ts applies, so a document can't declare a
  // redirect_uris entry (javascript:, cleartext http on a non-loopback host, embedded userinfo,
  // ...) that a DCR registration would be rejected for.
  redirect_uris: z.preprocess(
    (value) => capOversizedArray(value, CIMD_MAX_REDIRECT_URIS),
    z
      .array(z.string().max(CIMD_MAX_URI_LENGTH, "redirect_uris entry is too long"))
      .min(1, "CIMD document missing redirect_uris[]")
      .max(CIMD_MAX_REDIRECT_URIS, "CIMD document has too many redirect_uris")
      .refine(
        (uris) => uris.length > CIMD_MAX_REDIRECT_URIS || uris.every((uri) => validateRedirectUri(uri) === null),
        { message: "redirect_uris contains an unacceptable URI" }
      )
  ),
  // The document lists what the client supports; we only require the grant we drive.
  grant_types: z
    .preprocess(
      (value) => capOversizedArray(value, CIMD_MAX_GRANT_TYPES),
      z
        .array(z.string())
        .max(CIMD_MAX_GRANT_TYPES, "CIMD document has too many grant_types")
        .refine((types) => types.length > CIMD_MAX_GRANT_TYPES || types.includes("authorization_code"), {
          message: "CIMD grant_types must include 'authorization_code'",
        })
    )
    .optional(),
  response_types: z
    .preprocess(
      (value) => capOversizedArray(value, CIMD_MAX_RESPONSE_TYPES),
      z.array(z.string()).max(CIMD_MAX_RESPONSE_TYPES, "CIMD document has too many response_types")
    )
    .optional(),
  token_endpoint_auth_method: z
    .literal("none", { message: "CIMD token_endpoint_auth_method must be 'none'" })
    .optional(),
  logo_uri: z.string().max(CIMD_MAX_URI_LENGTH, "logo_uri is too long").optional(),
  client_uri: z.string().max(CIMD_MAX_URI_LENGTH, "client_uri is too long").optional(),
});

export type CimdDocument = z.infer<typeof cimdDocumentSchema>;
