import { describe, expect, it, vi } from "vitest";
import { createConsoleAuditSink, createPrismaAuditSink, type AuditEntry } from "./audit";

const DEMO_SHOP = "demo.myshopify.com";
const TOKEN_ID = "token_1";

function buildEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    shopId: DEMO_SHOP,
    shopDomain: DEMO_SHOP,
    mcpTokenId: TOKEN_ID,
    toolName: "whoami",
    inputParams: {},
    output: { content: [] },
    mcpClient: "claude-code",
    status: "success",
    errorMessage: null,
    durationMs: 12,
    ...overrides,
  };
}

function buildAuditPrisma() {
  return { mcpAuditLog: { create: vi.fn().mockResolvedValue({}) } };
}

describe("createPrismaAuditSink", () => {
  it("writes one row carrying the tool, shop, and duration", async () => {
    const prisma = buildAuditPrisma();
    await createPrismaAuditSink(prisma)(buildEntry({ toolName: "echo", durationMs: 42 }));

    expect(prisma.mcpAuditLog.create).toHaveBeenCalledTimes(1);
    const { data } = prisma.mcpAuditLog.create.mock.calls[0]![0];
    expect(data).toMatchObject({
      shopId: DEMO_SHOP,
      mcpTokenId: TOKEN_ID,
      toolName: "echo",
      durationMs: 42,
    });
  });

  it("stringifies a numeric shop id, because the column is a string", async () => {
    const prisma = buildAuditPrisma();
    await createPrismaAuditSink(prisma)(buildEntry({ shopId: 77 }));

    expect(prisma.mcpAuditLog.create.mock.calls[0]![0].data.shopId).toBe("77");
  });

  it("records the failure message on an error entry", async () => {
    const prisma = buildAuditPrisma();
    await createPrismaAuditSink(prisma)(buildEntry({ status: "error", errorMessage: "handler exploded" }));

    expect(prisma.mcpAuditLog.create.mock.calls[0]![0].data).toMatchObject({
      status: "error",
      errorMessage: "handler exploded",
    });
  });

  it("never writes null into the non-nullable inputParams column", async () => {
    const prisma = buildAuditPrisma();
    await createPrismaAuditSink(prisma)(buildEntry({ inputParams: undefined }));

    expect(prisma.mcpAuditLog.create.mock.calls[0]![0].data.inputParams).toEqual({});
  });
});

describe("createConsoleAuditSink", () => {
  it("logs one line naming the tool, the shop, and the outcome", async () => {
    const logger = { info: vi.fn() };
    await createConsoleAuditSink(logger)(buildEntry({ toolName: "echo", status: "error" }));

    expect(logger.info).toHaveBeenCalledTimes(1);
    const line = logger.info.mock.calls[0]![0] as string;
    expect(line).toContain("echo");
    expect(line).toContain(DEMO_SHOP);
    expect(line).toContain("error");
  });
});
