import type { ErrorRequestHandler } from "express";
import { GENERIC_SERVER_ERROR_BODY } from "../controllers/asyncHandler";
import type { Logger } from "../types";

// asyncHandler (controllers/asyncHandler.ts) only ever sees an error that occurs *inside* a
// wrapped controller. A body-parser mounted ahead of this package's router — e.g. the consumer's
// own `app.use(express.json())` — throws its SyntaxError before any request reaches inside the
// router at all, so no per-route guard, asyncHandler included, ever runs for it; left alone,
// Express's own default handler answers with an HTML stack trace instead.
//
// Express only ever searches for the next error-handling (4-arg) middleware within the stack
// level where the error occurred. A sub-router mounted via `app.use(router)` is itself an
// ordinary (3-arg) layer to its parent, so an error thrown before the router is reached skips
// over the router's *entire* internal stack, including any error handler mounted inside it —
// verified empirically, not assumed. In one sentence: an error thrown by a parent-level
// middleware (the consumer's own body-parser, above all) never enters this package's router at
// all, so nothing mounted inside `buildRouter`'s own Router (see ../router.ts) can ever catch it.
// This export exists so the consumer can *also* mount it — as their own app's LAST `app.use(...)`
// call, after their body-parsers AND after `app.use(oauth.router)`, never inside a router of
// their own — which closes that gap, because at that point it shares the same stack level the
// body-parser error occurred in. Both mounts matter and do different jobs: this one (exported on
// `ShopifyMcpOAuth.errorHandler`) protects the whole app; the one router.ts mounts internally
// protects anything that throws synchronously inside the router's own stack (a middleware this
// package mounts itself, or a future controller that forgets to wrap with asyncHandler) even if
// the consumer never wires the app-level one. Don't "simplify" this down to one mount — see
// router.ts's own mutation-tested proof that each one guards a different origin.
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    logger.error("shopify-mcp-oauth: unhandled error", err);
    res.status(500).json(GENERIC_SERVER_ERROR_BODY);
  };
}
