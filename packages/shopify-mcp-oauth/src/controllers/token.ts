import type { RequestHandler, Response } from "express";
import type { ResolvedConfig } from "../config";
import { tokenRequestSchema, type AuthorizationCodeGrant, type RefreshTokenGrant } from "../schemas/token";
import { serializeTokenBundle } from "../serializers/token";
import { consumeCode } from "../services/codes";
import { verifyS256 } from "../services/pkce";
import { issueTokens, rotateRefresh } from "../services/tokens";
import { asyncHandler } from "./asyncHandler";

function bad(res: Response, code: string, description: string): void {
  res.status(400).json({ error: code, error_description: description });
}

async function handleAuthorizationCode(
  config: ResolvedConfig,
  grant: AuthorizationCodeGrant,
  res: Response
): Promise<void> {
  // Consumed first: a failed attempt still burns the code, so a wrong verifier gets no retry.
  const record = await consumeCode(config, grant.code);
  if (!record) return bad(res, "invalid_grant", "code unknown, expired, or already used");
  if (record.clientId !== grant.client_id) return bad(res, "invalid_grant", "client_id mismatch");
  // Deliberately strict, not redirectUriMatches: the record holds the exact string the client
  // presented at /authorize (after that endpoint already matched it against the client's
  // registered URIs, where loopback port flexibility per RFC 8252 §7.3 belongs). RFC 6749
  // §4.1.3 requires this leg's redirect_uri be identical to the one in the authorization
  // request, so re-applying the loopback allowance here would let a code bound to one local
  // listener be redeemed by a different one on the same host.
  if (record.redirectUri !== grant.redirect_uri) {
    return bad(res, "invalid_grant", "redirect_uri mismatch");
  }
  // The record's method isn't a literal type at rest, so a stored "plain" (or anything but
  // "S256") is rejected outright rather than falling through to a hash comparison that would
  // just fail closed today but silently open the door if a "plain" branch is ever added later.
  if (record.codeChallengeMethod !== "S256") {
    return bad(res, "invalid_grant", "unsupported code_challenge_method");
  }
  if (!verifyS256(grant.code_verifier, record.codeChallenge)) {
    return bad(res, "invalid_grant", "PKCE verifier failed");
  }

  const tokens = await issueTokens(config, {
    shopId: record.shopId,
    shopDomain: record.shopDomain,
    clientId: record.clientId,
    resource: record.resource,
  });
  res.status(200).json(serializeTokenBundle(tokens));
}

async function handleRefreshToken(config: ResolvedConfig, grant: RefreshTokenGrant, res: Response): Promise<void> {
  const rotated = await rotateRefresh(config, grant.refresh_token, grant.client_id);
  if (!rotated) return bad(res, "invalid_grant", "refresh_token unknown, expired, or already rotated");
  res.status(200).json(serializeTokenBundle(rotated));
}

export function tokenController(config: ResolvedConfig): RequestHandler {
  return asyncHandler(config.logger, async (req, res) => {
    // RFC 6749 §5.1: a token response — success or error — must never be cached. Set this before
    // any branch below, since a shared or browser cache holding a response that carries (or once
    // carried) a bearer token would leak it to whoever reuses that cache entry next.
    res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });

    const body = req.body;
    if (!body || typeof body !== "object") return bad(res, "invalid_request", "body required");

    const parsed = tokenRequestSchema.safeParse(body);
    if (!parsed.success) {
      const grantType = (body as Record<string, unknown>).grant_type;
      // RFC 6749 §5.2: a missing required parameter is invalid_request; unsupported_grant_type is
      // only for a grant_type that was actually presented and isn't one this server implements.
      // "Missing" covers null and "" too, not just an absent key — a bare `grant_type=` in a
      // form-encoded body (the encoding most OAuth clients use) parses to an empty string.
      if (grantType === undefined || grantType === null || grantType === "") {
        return bad(res, "invalid_request", "grant_type is required");
      }
      const known = grantType === "authorization_code" || grantType === "refresh_token";
      if (!known) {
        // Fixed text, never the submitted value: reflecting caller-controlled input back into the
        // response body is the same class of leak this package already avoids for zod issues.
        return bad(res, "unsupported_grant_type", "grant_type is not supported");
      }
      return bad(res, "invalid_request", parsed.error.issues[0]?.message ?? "invalid request");
    }

    if (parsed.data.grant_type === "authorization_code") {
      return handleAuthorizationCode(config, parsed.data, res);
    }
    return handleRefreshToken(config, parsed.data, res);
  });
}
