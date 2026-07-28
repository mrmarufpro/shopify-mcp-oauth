import type { ResolvedConfig } from "../config";
import { randomBase64Url } from "../crypto";
import type { CimdDocument } from "../schemas/cimd";
import type { RegisterRequest } from "../schemas/register";
import type { OAuthClient } from "../types";

export async function createDcrClient(config: ResolvedConfig, input: RegisterRequest): Promise<OAuthClient> {
  return config.storage.createClient({
    clientId: randomBase64Url(32),
    clientName: input.client_name ?? null,
    redirectUris: input.redirect_uris,
    grantTypes: input.grant_types ?? null,
    responseTypes: input.response_types ?? null,
    logoUri: input.logo_uri ?? null,
    clientUri: input.client_uri ?? null,
    // We never issue client secrets, so the client authenticates with PKCE alone.
    tokenEndpointAuthMethod: "none",
  });
}

export async function upsertCimdClient(
  config: ResolvedConfig,
  clientIdUrl: string,
  doc: CimdDocument
): Promise<OAuthClient> {
  return config.storage.upsertClient({
    clientId: clientIdUrl,
    clientName: doc.client_name ?? null,
    redirectUris: doc.redirect_uris,
    grantTypes: doc.grant_types ?? null,
    responseTypes: doc.response_types ?? null,
    logoUri: doc.logo_uri ?? null,
    clientUri: doc.client_uri ?? null,
    tokenEndpointAuthMethod: "none",
  });
}

export function clientToCimdDocument(client: OAuthClient): CimdDocument {
  return {
    client_name: client.clientName ?? undefined,
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes ?? undefined,
    response_types: client.responseTypes ?? undefined,
    logo_uri: client.logoUri ?? undefined,
    client_uri: client.clientUri ?? undefined,
    token_endpoint_auth_method: "none",
  };
}
