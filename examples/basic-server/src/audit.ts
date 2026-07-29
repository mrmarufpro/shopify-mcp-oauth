export interface AuditEntry {
  shopId: string | number;
  shopDomain: string;
  mcpTokenId: string | null;
  toolName: string;
  inputParams: unknown;
  output: unknown;
  mcpClient: string | null;
  status: "success" | "error";
  errorMessage: string | null;
  durationMs: number;
}

export type AuditSink = (entry: AuditEntry) => Promise<void>;

/** Structural, so this file never imports `@prisma/client` and the memory variant can drop it. */
export interface AuditPrismaClient {
  mcpAuditLog: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
}

export function createPrismaAuditSink(prisma: AuditPrismaClient): AuditSink {
  return async (entry) => {
    await prisma.mcpAuditLog.create({
      data: {
        shopId: String(entry.shopId),
        mcpTokenId: entry.mcpTokenId,
        toolName: entry.toolName,
        inputParams: entry.inputParams ?? {},
        output: entry.output ?? null,
        mcpClient: entry.mcpClient,
        status: entry.status,
        errorMessage: entry.errorMessage,
        durationMs: entry.durationMs,
      },
    });
  };
}

export function createConsoleAuditSink(logger: Pick<Console, "info"> = console): AuditSink {
  return async (entry) => {
    const suffix = entry.errorMessage ? ` — ${entry.errorMessage}` : "";
    logger.info(
      `[mcp] ${entry.toolName} ${entry.status} ${entry.durationMs}ms shop=${entry.shopDomain} client=${
        entry.mcpClient ?? "unknown"
      }${suffix}`
    );
  };
}
