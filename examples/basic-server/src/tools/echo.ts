import { z } from "zod";
import { withAuditLog } from "../mcp/withAuditLog";

const echoInputSchema = z.object({
  message: z.string().min(1).max(1000).describe("Text to send back unchanged"),
});

export const echoTool = {
  name: "echo",
  config: {
    title: "Echo",
    description: "Return the message you send, unchanged. Useful for checking that the connection works.",
    inputSchema: echoInputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  callback: withAuditLog({
    toolName: "echo",
    schema: echoInputSchema,
    handler: async (input) => ({
      content: [{ type: "text" as const, text: JSON.stringify({ message: input.message }, null, 2) }],
    }),
  }),
};
