import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const SERVER_NAME = "basic-server";
const SERVER_VERSION = "0.1.0";

export function buildMcpServer(): McpServer {
  return new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tools in this server act on one Shopify store — the one the merchant authenticated. " +
        "Call whoami first if you need to confirm which store that is.",
    }
  );
}
