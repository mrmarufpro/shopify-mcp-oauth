import { z } from "zod";
import { withAuditLog } from "../mcp/withAuditLog";

const whoamiInputSchema = z.object({});

export const whoamiTool = {
  name: "whoami",
  config: {
    title: "Who am I",
    description:
      "Return the Shopify shop domain this MCP connection is authenticated for. Call it to confirm which store the tools will act on.",
    inputSchema: whoamiInputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  callback: withAuditLog({
    toolName: "whoami",
    schema: whoamiInputSchema,
    handler: async (_input, ctx) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ shop: ctx.auth.shopDomain, client: ctx.mcpClient }, null, 2),
        },
      ],
    }),
  }),
};
