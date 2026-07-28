import type { IssuedTokens } from "../services/tokens";

export function serializeTokenBundle(tokens: IssuedTokens): Record<string, unknown> {
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type,
    expires_in: tokens.expires_in,
    scope: tokens.scope,
  };
}
