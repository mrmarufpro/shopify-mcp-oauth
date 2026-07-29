import { createApp } from "./app";
import { loadConfig } from "./config";
import { auditSink, storage } from "./storage";

const config = loadConfig();

const app = createApp({
  host: config.host,
  shopify: config.shopify,
  stateSecret: config.stateSecret,
  storage,
  audit: auditSink,
});

app.listen(config.port, () => {
  console.log(`MCP server listening on port ${config.port}`);
  console.log(`Public host: ${config.host}`);
  console.log(`Connect with: claude mcp add --transport http my-mcp ${config.host}/mcp`);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});
