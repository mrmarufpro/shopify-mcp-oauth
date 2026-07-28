import { z } from "zod";

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
  redirect_uris: z
    .array(z.string().max(CIMD_MAX_URI_LENGTH, "redirect_uris entry is too long"))
    .min(1, "CIMD document missing redirect_uris[]")
    .max(CIMD_MAX_REDIRECT_URIS, "CIMD document has too many redirect_uris"),
  // The document lists what the client supports; we only require the grant we drive.
  grant_types: z
    .array(z.string())
    .max(CIMD_MAX_GRANT_TYPES, "CIMD document has too many grant_types")
    .refine((types) => types.includes("authorization_code"), {
      message: "CIMD grant_types must include 'authorization_code'",
    })
    .optional(),
  response_types: z
    .array(z.string())
    .max(CIMD_MAX_RESPONSE_TYPES, "CIMD document has too many response_types")
    .optional(),
  token_endpoint_auth_method: z
    .literal("none", { message: "CIMD token_endpoint_auth_method must be 'none'" })
    .optional(),
  logo_uri: z.string().max(CIMD_MAX_URI_LENGTH, "logo_uri is too long").optional(),
  client_uri: z.string().max(CIMD_MAX_URI_LENGTH, "client_uri is too long").optional(),
});

export type CimdDocument = z.infer<typeof cimdDocumentSchema>;
