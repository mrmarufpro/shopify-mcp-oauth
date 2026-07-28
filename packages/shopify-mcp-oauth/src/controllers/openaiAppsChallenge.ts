import type { RequestHandler } from "express";

export function openaiAppsChallengeController(token: string | null): RequestHandler {
  return (_req, res) => {
    if (!token) {
      res.status(404).type("text/plain").send("not configured");
      return;
    }
    res.status(200).type("text/plain").send(token);
  };
}
