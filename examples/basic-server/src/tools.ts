import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpAuthContext } from "shopify-mcp-oauth";
import { z } from "zod";

/**
 * Add your tools here.
 *
 * `auth` is what `oauth.requireAuth` put on `req.mcp`: the shop this connection was authenticated
 * for. app.ts builds one server per request, so a tool can read it straight from this closure —
 * the MCP SDK hands tool callbacks request headers only, never the Express request, so without
 * that a tool has no way to tell which store is calling.
 */
export function buildMcpServer(auth: McpAuthContext): McpServer {
  const server = new McpServer(
    { name: "basic-server", version: "0.1.0" },
    { instructions: "Every tool here acts on the one Shopify store the merchant authenticated." }
  );

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description: "Return the Shopify shop domain this connection is authenticated for.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ({ content: [{ type: "text", text: auth.shopDomain }] })
  );

  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Return the message you send, unchanged. Handy for checking the connection works.",
      inputSchema: { message: z.string().min(1).describe("Text to send back") },
      annotations: { readOnlyHint: true },
    },
    async ({ message }) => ({ content: [{ type: "text", text: message }] })
  );

  return server;
}
