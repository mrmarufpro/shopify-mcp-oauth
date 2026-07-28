import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../types";
import { asyncHandler } from "./asyncHandler";

function buildApp(logger: Logger, handler: Parameters<typeof asyncHandler>[1]) {
  const app = express();
  app.get("/probe", asyncHandler(logger, handler));
  return app;
}

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

describe("asyncHandler", () => {
  it("runs the wrapped handler and lets it respond normally", async () => {
    const app = buildApp(silentLogger, async (_req, res) => {
      res.status(201).json({ ok: true });
    });
    const response = await request(app).get("/probe");
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ ok: true });
  });

  it("turns a rejected promise into a generic 500 instead of hanging or crashing", async () => {
    const app = buildApp(silentLogger, async () => {
      throw new Error("storage unavailable: connection to db.internal.example refused");
    });
    const response = await request(app).get("/probe");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "server_error", error_description: "An unexpected error occurred" });
  });

  it("never lets the original error message or stack reach the response body", async () => {
    const app = buildApp(silentLogger, async () => {
      throw new Error("storage unavailable: connection to db.internal.example refused");
    });
    const response = await request(app).get("/probe");
    expect(JSON.stringify(response.body)).not.toContain("db.internal.example");
    expect(JSON.stringify(response.body)).not.toContain(".ts:");
  });

  it("logs the failure instead of swallowing it silently", async () => {
    const errorLog = vi.fn();
    const app = buildApp({ info: () => {}, warn: () => {}, error: errorLog }, async () => {
      throw new Error("boom");
    });
    await request(app).get("/probe");
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it("forwards to next(err) instead of double-responding once headers are already sent", async () => {
    const nextSpy = vi.fn();
    const app = express();
    app.get(
      "/probe",
      asyncHandler(silentLogger, async (_req, res) => {
        res.status(200).json({ ok: true });
        throw new Error("failure after the response was already flushed");
      })
    );
    app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      nextSpy(err);
      next(err);
    });
    const response = await request(app).get("/probe");
    expect(response.status).toBe(200);
    expect(nextSpy).toHaveBeenCalledTimes(1);
  });
});
