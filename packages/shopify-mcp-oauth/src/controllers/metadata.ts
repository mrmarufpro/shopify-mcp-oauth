import type { RequestHandler } from "express";
import type { ResolvedConfig } from "../config";
import { serializeAuthorizationServerMetadata, serializeProtectedResourceMetadata } from "../serializers/metadata";

export function authorizationServerMetadataController(config: ResolvedConfig): RequestHandler {
  const body = serializeAuthorizationServerMetadata(config);
  return (_req, res) => {
    res.status(200).json(body);
  };
}

export function protectedResourceMetadataController(config: ResolvedConfig): RequestHandler {
  const body = serializeProtectedResourceMetadata(config);
  return (_req, res) => {
    res.status(200).json(body);
  };
}
