import type { RequestHandler } from "express";
import type { ResolvedConfig } from "../config";
import { revokeRequestSchema } from "../schemas/revoke";
import { revokeByAccessToken, revokeByRefreshToken } from "../services/tokens";
import { asyncHandler } from "./asyncHandler";

export function revokeController(config: ResolvedConfig): RequestHandler {
  return asyncHandler(config.logger, async (req, res) => {
    const parsed = revokeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_request",
        error_description: parsed.error.issues[0]?.message ?? "token is required",
      });
      return;
    }
    // RFC 7009 §2.2: answer 200 whether or not the token existed, so the endpoint cannot be
    // used to test token guesses.
    //
    // Both lookups always run, regardless of token_type_hint. RFC 7009 §2.1 allows a hint as a
    // lookup optimization but requires falling back to the other token types when it doesn't
    // resolve -- access and refresh tokens are both opaque, same-shape random strings (see
    // services/tokens.ts), so a client that submits an access token but hints "refresh_token" (or
    // vice versa) is entirely plausible, not just a hypothetical. A hint-only lookup would answer
    // 200 -- the same success response as a real revocation -- while the submitted token stays
    // live: the caller is told it's revoked when it isn't.
    await revokeByAccessToken(config, parsed.data.token);
    await revokeByRefreshToken(config, parsed.data.token);
    res.status(200).json({});
  });
}
