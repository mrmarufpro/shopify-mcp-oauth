import type { RequestHandler } from "express";
import type { ResolvedConfig } from "../config";
import { revokeRequestSchema } from "../schemas/revoke";
import { revokeByAccessToken, revokeByRefreshToken } from "../services/tokens";

export function revokeController(config: ResolvedConfig): RequestHandler {
  return async (req, res) => {
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
    if (parsed.data.token_type_hint === "refresh_token") {
      await revokeByRefreshToken(config, parsed.data.token);
    } else {
      await revokeByAccessToken(config, parsed.data.token);
      await revokeByRefreshToken(config, parsed.data.token);
    }
    res.status(200).json({});
  };
}
