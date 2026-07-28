import type { ResolvedConfig } from "../config";

export function serializeAuthorizationServerMetadata(config: ResolvedConfig): Record<string, unknown> {
  return {
    issuer: config.host,
    authorization_endpoint: `${config.host}/authorize`,
    token_endpoint: `${config.host}/token`,
    registration_endpoint: `${config.host}/register`,
    revocation_endpoint: `${config.host}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["mcp:*"],
    client_id_metadata_document_supported: true,
  };
}

export function serializeProtectedResourceMetadata(config: ResolvedConfig): Record<string, unknown> {
  return {
    resource: config.resource,
    authorization_servers: [config.host],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp:*"],
  };
}
