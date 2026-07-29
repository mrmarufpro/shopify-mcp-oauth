import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { echoTool } from "./echo";
import { whoamiTool } from "./whoami";

export function registerTools(server: McpServer): void {
  server.registerTool(whoamiTool.name, whoamiTool.config, whoamiTool.callback);
  server.registerTool(echoTool.name, echoTool.config, echoTool.callback);
}
