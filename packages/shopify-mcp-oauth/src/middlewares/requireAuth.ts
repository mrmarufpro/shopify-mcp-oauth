import type { RequestHandler } from "express";
import { createAuthenticator } from "../authenticate";
import type { ResolvedConfig } from "../config";
import { asyncHandler } from "../controllers/asyncHandler";
// The Express.Request augmentation that makes `req.mcp` typecheck lives in ../types, not here --
// see the comment there for why it has to be colocated with a re-exported symbol rather than with
// the function that actually populates it at runtime.

/**
 * The mount-and-forget form of `authenticate` + `challenge` (see ../authenticate.ts, which owns
 * every check this enforces). A server that accepts a second credential scheme of its own can't
 * use this -- it answers the request itself on failure, so nothing can run after it -- and should
 * compose those two directly instead.
 */
export function requireAuth(config: ResolvedConfig): RequestHandler {
  const { authenticate, challenge } = createAuthenticator(config);

  // A storage failure here must become a controlled 500, not an unhandled rejection --
  // asyncHandler is the seam that already owns that translation for every other handler.
  return asyncHandler(config.logger, async (req, res, next) => {
    const result = await authenticate(req);
    if (!result.ok) return challenge(res, result.reason);

    req.mcp = result.context;
    next();
  });
}
