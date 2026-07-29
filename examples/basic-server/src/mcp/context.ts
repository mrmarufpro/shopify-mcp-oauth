import { AsyncLocalStorage } from "node:async_hooks";
import type { McpAuthContext } from "shopify-mcp-oauth";
import type { AuditSink } from "../audit";

export interface McpRequestContext {
  auth: McpAuthContext;
  mcpClient: string;
  audit: AuditSink;
}

const contextStorage = new AsyncLocalStorage<McpRequestContext>();

export function runWithMcpContext<T>(context: McpRequestContext, fn: () => Promise<T>): Promise<T> {
  return contextStorage.run(context, fn);
}

export function getMcpContext(): McpRequestContext | null {
  return contextStorage.getStore() ?? null;
}
