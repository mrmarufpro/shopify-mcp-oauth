import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../types";
import { errorHandler } from "./errorHandler";

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

// Stands in for a consumer's own body-parser (or any middleware mounted ahead of this package's
// router) throwing before a request ever reaches inside it — the exact scenario errorHandler.ts
// exists to close. `next(err)` is how Express itself routes a thrown/rejected error to the next
// error-handling middleware in the same stack; this fake reproduces that hand-off without needing
// a real malformed body on the wire.
function buildApp(logger: Logger) {
  const app = express();
  app.get("/probe", (_req, _res, next) => {
    next(new Error("storage unavailable: connection to db.internal.example refused"));
  });
  app.use(errorHandler(logger));
  return app;
}

describe("errorHandler", () => {
  it("converts an error passed via next() into a generic 500", async () => {
    const response = await request(buildApp(silentLogger)).get("/probe");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "server_error", error_description: "An unexpected error occurred" });
  });

  it("never lets the original error message or stack reach the response body", async () => {
    const response = await request(buildApp(silentLogger)).get("/probe");
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain("db.internal.example");
    expect(raw).not.toContain(".ts:");
  });

  it("logs the failure instead of swallowing it silently", async () => {
    const errorLog = vi.fn();
    await request(buildApp({ info: () => {}, warn: () => {}, error: errorLog })).get("/probe");
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it("forwards to next(err) instead of double-responding once headers are already sent", async () => {
    const nextSpy = vi.fn();
    const app = express();
    app.get("/probe", (_req, res, next) => {
      res.status(200).json({ ok: true });
      next(new Error("failure after the response was already flushed"));
    });
    app.use(errorHandler(silentLogger));
    app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      nextSpy(err);
      next(err);
    });
    const response = await request(app).get("/probe");
    expect(response.status).toBe(200);
    expect(nextSpy).toHaveBeenCalledTimes(1);
  });

  it("produces the exact same body as asyncHandler's own generic 500, so the two can never drift", async () => {
    const { asyncHandler } = await import("../controllers/asyncHandler");
    const asyncHandlerApp = express();
    asyncHandlerApp.get(
      "/probe",
      asyncHandler(silentLogger, async () => {
        throw new Error("boom");
      })
    );
    const fromAsyncHandler = await request(asyncHandlerApp).get("/probe");
    const fromErrorHandler = await request(buildApp(silentLogger)).get("/probe");
    expect(fromErrorHandler.body).toEqual(fromAsyncHandler.body);
    expect(fromErrorHandler.status).toBe(fromAsyncHandler.status);
  });
});
