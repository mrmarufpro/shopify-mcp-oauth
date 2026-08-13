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
// A body-parser rejection is the client's fault, not this server's, and it carries the status that
// says so: 400 entity.parse.failed, 413 entity.too.large, 415 charset.unsupported (http-errors sets
// `status` on all three). Answering 500 for them is wrong twice over. On /token it breaks RFC 6749
// §5.2, which requires a malformed token request to be refused with 400 invalid_request — a client
// told "server_error" retries a request that can never succeed. And because router.ts now mounts
// those parsers on the router's own routes, these arrive as ordinary traffic rather than as a
// symptom of a broken deployment, so logging every one of them at `error` buries real faults under
// noise an unauthenticated caller can generate at will (neither /token nor the parse step of any
// route is rate limited).
//
// Only the status is taken from the error, never its message: body-parser's text names the parser
// and the byte offset it gave up at, which is detail about this server's internals that an
// unauthenticated caller has no business reading.
const CLIENT_ERROR_DESCRIPTIONS: Record<number, string> = {
  400: "The request body could not be parsed",
  413: "The request body is too large",
  415: "The request content type is not supported",
};
const GENERIC_CLIENT_ERROR_DESCRIPTION = "The request could not be processed";

function clientErrorStatus(err: unknown): number | null {
  const status = (err as { status?: unknown; statusCode?: unknown } | null)?.status;
  const fallback = (err as { statusCode?: unknown } | null)?.statusCode;
  const value = typeof status === "number" ? status : typeof fallback === "number" ? fallback : null;
  if (value === null || !Number.isInteger(value) || value < 400 || value > 499) return null;
  return value;
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    const clientStatus = clientErrorStatus(err);
    if (clientStatus !== null) {
      // `warn`, not `error`: this is worth seeing when a client is misbehaving, but it is not a
      // fault of this server and must not page anyone. `invalid_request` is the RFC 6749 §5.2 code
      // for a malformed request, and is also the closest fit on /register (RFC 7591) and /revoke.
      logger.warn("shopify-mcp-oauth: rejected a malformed request", { status: clientStatus });
      res.status(clientStatus).json({
        error: "invalid_request",
        error_description: CLIENT_ERROR_DESCRIPTIONS[clientStatus] ?? GENERIC_CLIENT_ERROR_DESCRIPTION,
      });
      return;
    }

    logger.error("shopify-mcp-oauth: unhandled error", err);
    res.status(500).json(GENERIC_SERVER_ERROR_BODY);
  };
}
