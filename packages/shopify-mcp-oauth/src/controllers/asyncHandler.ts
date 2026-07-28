import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Logger } from "../types";

type AsyncControllerHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

// Exported so middlewares/errorHandler.ts — the terminal handler for errors this wrapper never
// gets a chance to see — answers with the exact same body. Two call sites hand-typing the same
// literal would drift silently; importing this one guarantees they can't.
export const GENERIC_SERVER_ERROR_BODY = { error: "server_error", error_description: "An unexpected error occurred" };

// Express 4 drops a route handler's rejected promise on the floor — the request hangs, and
// Node's default unhandled-rejection policy then kills the process. Express 5 forwards the
// rejection to next(err) on its own, but this package can't assume the consumer mounted a
// terminal error handler downstream, so this wrapper owns the response itself rather than
// leaving an unauthenticated caller to whatever (if anything) Express's own default handler
// would have sent — including a stack trace, which it prints outside of NODE_ENV=production.
export function asyncHandler(logger: Logger, handler: AsyncControllerHandler): RequestHandler {
  return (req, res, next) => {
    // The type says handler always returns a Promise, and a genuinely `async` function can't
    // violate that — but nothing at the type level stops a caller from passing a plain function
    // that throws before ever returning one, and this seam is about to carry several more
    // controllers (Tasks 15-17). Routing the call through Promise.resolve().then(...) means a
    // synchronous throw lands in the same .catch() as a real rejection, so it still gets this
    // package's generic response instead of whatever Express's own default handler would have
    // sent. Not a live bug today — every controller built so far is a true async function.
    Promise.resolve()
      .then(() => handler(req, res, next))
      .catch((err: unknown) => {
        if (res.headersSent) {
          next(err);
          return;
        }
        logger.error("shopify-mcp-oauth: unhandled controller error", err);
        res.status(500).json(GENERIC_SERVER_ERROR_BODY);
      });
  };
}
