import type { OAuthClient } from "../types";

export function serializeClientRegistration(client: OAuthClient): Record<string, unknown> {
  return {
    client_id: client.clientId,
    client_name: client.clientName ?? undefined,
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes ?? ["authorization_code", "refresh_token"],
    response_types: client.responseTypes ?? ["code"],
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    logo_uri: client.logoUri ?? undefined,
    client_uri: client.clientUri ?? undefined,
  };
}
