import { z } from "zod";

export const cimdDocumentSchema = z
  .object({
    client_id: z.string().optional(),
    client_name: z.string().optional(),
    redirect_uris: z.array(z.string()).min(1, "CIMD document missing redirect_uris[]"),
    // The document lists what the client supports; we only require the grant we drive.
    grant_types: z
      .array(z.string())
      .refine((types) => types.includes("authorization_code"), {
        message: "CIMD grant_types must include 'authorization_code'",
      })
      .optional(),
    response_types: z.array(z.string()).optional(),
    token_endpoint_auth_method: z
      .literal("none", { message: "CIMD token_endpoint_auth_method must be 'none'" })
      .optional(),
    logo_uri: z.string().optional(),
    client_uri: z.string().optional(),
  })
  .strip();

export type CimdDocument = z.infer<typeof cimdDocumentSchema>;
