import type { RequestHandler } from "express";
import type { ResolvedConfig } from "../config";
import { registerRequestSchema } from "../schemas/register";
import { serializeClientRegistration } from "../serializers/register";
import { createDcrClient } from "../services/clients";

export function registerController(config: ResolvedConfig): RequestHandler {
  return async (req, res) => {
    const parsed = registerRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_client_metadata",
        error_description: parsed.error.issues[0]?.message ?? "body must be a JSON object",
      });
      return;
    }
    const client = await createDcrClient(config, parsed.data);
    res.status(201).json(serializeClientRegistration(client));
  };
}
