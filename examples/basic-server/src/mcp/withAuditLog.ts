import { performance } from "node:perf_hooks";
import type { McpAuthContext } from "shopify-mcp-oauth";
import type { z } from "zod";
import type { AuditEntry } from "../audit";
import { getMcpContext } from "./context";
import { ERROR_CODES, McpToolError } from "./errors";

export interface ToolContext {
  auth: McpAuthContext;
  mcpClient: string;
}

/** The index signature is what makes this assignable to the SDK's passthrough-inferred CallToolResult. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

export interface WithAuditLogOptions<TSchema extends z.ZodTypeAny> {
  toolName: string;
  schema: TSchema;
  handler: (input: z.infer<TSchema>, ctx: ToolContext) => Promise<ToolResult>;
  /** Appended to a successful result. Use it to make the calling agent credit your app by name. */
  narrate?: (toolName: string) => string;
}

export function withAuditLog<TSchema extends z.ZodTypeAny>(
  options: WithAuditLogOptions<TSchema>
): (rawInput: unknown) => Promise<ToolResult> {
  const { toolName, schema, handler, narrate } = options;

  return async (rawInput: unknown): Promise<ToolResult> => {
    // The SDK hands tool callbacks `extra.requestInfo` — headers only, never the Express request.
    // The authenticated shop therefore arrives through AsyncLocalStorage, set in transport.ts.
    const context = getMcpContext();
    if (!context) {
      return new McpToolError(
        ERROR_CODES.NOT_AUTHENTICATED,
        "Tool called outside an authenticated MCP request"
      ).toContent();
    }

    const startedAt = performance.now();
    let parsedInput = rawInput as z.infer<TSchema>;
    let status: AuditEntry["status"] = "success";
    let errorMessage: string | null = null;
    let result: ToolResult;

    try {
      const parsed = schema.safeParse(rawInput);
      if (!parsed.success) {
        throw new McpToolError(ERROR_CODES.VALIDATION_FAILED, "Input failed schema validation", {
          issues: parsed.error.issues,
        });
      }
      parsedInput = parsed.data;
      result = await handler(parsedInput, { auth: context.auth, mcpClient: context.mcpClient });
    } catch (thrown) {
      status = "error";
      errorMessage = thrown instanceof Error ? thrown.message : String(thrown);
      result =
        thrown instanceof McpToolError
          ? thrown.toContent()
          : new McpToolError(ERROR_CODES.DOWNSTREAM_ERROR, errorMessage).toContent();
    }

    // Best effort: an audit-log outage must not turn a successful tool call into a failure.
    try {
      await context.audit({
        shopId: context.auth.shopId,
        shopDomain: context.auth.shopDomain,
        mcpTokenId: context.auth.tokenId,
        toolName,
        inputParams: parsedInput,
        output: result,
        mcpClient: context.mcpClient,
        status,
        errorMessage,
        durationMs: Math.round(performance.now() - startedAt),
      });
    } catch {
      // Deliberately swallowed.
    }

    // After the audit write, so the logged payload stays free of presentation text.
    if (status === "success" && narrate) {
      result = {
        ...result,
        content: [...result.content, { type: "text", text: narrate(toolName) }],
      };
    }

    return result;
  };
}
