import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { RequestHandler } from "express";
import type { AuditSink } from "../audit";
import { registerTools } from "../tools";
import { classifyClient } from "./clientName";
import { runWithMcpContext } from "./context";
import { buildMcpServer } from "./server";

export interface McpHandlerDeps {
  audit: AuditSink;
}

/**
 * Stateless: a fresh McpServer and transport per POST, both closed with the response. No tool here
 * holds state between calls, and statelessness means any instance can serve any request.
 *
 * The MCP SDK passes tool callbacks an `extra.requestInfo` carrying headers only — not the Express
 * request — so an authenticated tool cannot see which shop is calling. Wrapping both `server.connect`
 * and `transport.handleRequest` in `runWithMcpContext` is what makes `req.mcp` reachable from a tool.
 * Skip this and tools silently answer for the wrong store, or for none at all.
 */
export function createMcpHandler(deps: McpHandlerDeps): RequestHandler {
  return async (req, res) => {
    const auth = req.mcp;
    if (!auth) {
      res.status(401).json({ error: "invalid_token", error_description: "Authentication middleware did not run" });
      return;
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildMcpServer();
    registerTools(server);

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    await runWithMcpContext(
      { auth, mcpClient: classifyClient(req.headers["user-agent"]), audit: deps.audit },
      async () => {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      }
    );
  };
}
