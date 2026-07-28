import type { ResolvedConfig } from "../config";
import { randomBase64Url, sha256Hex } from "../crypto";

const DEFAULT_SCOPE = "mcp:*";

export interface IssuedTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: "Bearer";
}

export interface IssueTokensInput {
  shopId: string | number;
  shopDomain: string;
  clientId: string;
  scope?: string;
  resource?: string;
  rotatedFromId?: string | null;
}

export async function issueTokens(config: ResolvedConfig, input: IssueTokensInput): Promise<IssuedTokens> {
  const accessToken = randomBase64Url(32);
  const refreshToken = randomBase64Url(32);
  const scope = input.scope ?? DEFAULT_SCOPE;
  const now = Date.now();

  await config.storage.createToken({
    shopId: input.shopId,
    shopDomain: input.shopDomain,
    clientId: input.clientId,
    accessTokenHash: sha256Hex(accessToken),
    refreshTokenHash: sha256Hex(refreshToken),
    accessTokenExpiresAt: new Date(now + config.tokenTtl.access * 1000),
    refreshTokenExpiresAt: new Date(now + config.tokenTtl.refresh * 1000),
    scope,
    resource: input.resource ?? config.resource,
    rotatedFromId: input.rotatedFromId ?? null,
  });

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: config.tokenTtl.access,
    scope,
    token_type: "Bearer",
  };
}

export async function rotateRefresh(
  config: ResolvedConfig,
  refreshToken: string,
  clientId: string
): Promise<IssuedTokens | null> {
  const existing = await config.storage.findTokenByRefreshHash(sha256Hex(refreshToken));
  if (!existing) return null;
  // Bind rotation to the presenting client: a stolen refresh token is useless to a different one.
  if (existing.clientId !== clientId) return null;
  // Only the caller whose revoke actually flipped the row may mint a replacement, so two
  // concurrent refreshes of the same token can't both win.
  const won = await config.storage.revokeToken(existing.id);
  if (!won) return null;

  return issueTokens(config, {
    shopId: existing.shopId,
    shopDomain: existing.shopDomain,
    clientId: existing.clientId,
    scope: existing.scope ?? undefined,
    resource: existing.resource ?? undefined,
    rotatedFromId: existing.id,
  });
}

export async function revokeByAccessToken(config: ResolvedConfig, token: string): Promise<void> {
  // Ignores expiry deliberately: an access token that has expired since it was issued still
  // names a real grant, and revocation must be able to kill that grant's refresh token too.
  const existing = await config.storage.findTokenByAccessHashIgnoringExpiry(sha256Hex(token));
  if (existing) await config.storage.revokeToken(existing.id);
}

export async function revokeByRefreshToken(config: ResolvedConfig, token: string): Promise<void> {
  const existing = await config.storage.findTokenByRefreshHash(sha256Hex(token));
  if (existing) await config.storage.revokeToken(existing.id);
}
