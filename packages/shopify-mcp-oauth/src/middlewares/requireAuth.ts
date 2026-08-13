import type { RequestHandler } from "express";
import type { Authenticator } from "../authenticate";
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
 *
 * The `Authenticator` is passed in rather than built here so that the one this wraps is the very
 * same object exposed as `oauth.authenticate` / `oauth.challenge`. Building a second one internally
 * would make the docs' claim -- that this *is* those two composed -- false in the one way that
 * matters: a consumer who wraps or replaces `oauth.authenticate` (tenant-scoped logging, a forced
 * failure in a test) would see the protected route sail on through the untouched copy.
 */
export function requireAuth(config: ResolvedConfig, authenticator: Authenticator): RequestHandler {
  // A storage failure here must become a controlled 500, not an unhandled rejection --
  // asyncHandler is the seam that already owns that translation for every other handler.
  return asyncHandler(config.logger, async (req, res, next) => {
    // Read off the object per request rather than destructured once at mount time, so a consumer
    // who wraps `oauth.authenticate` after mounting still has this route go through the wrapper.
    const result = await authenticator.authenticate(req);
    if (!result.ok) return authenticator.challenge(res, result.reason);

    req.mcp = result.context;
    next();
  });
}
