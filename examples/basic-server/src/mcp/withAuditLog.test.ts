import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AuditEntry, AuditSink } from "../audit";
import { runWithMcpContext } from "./context";
import { ERROR_CODES, McpToolError } from "./errors";
import { withAuditLog } from "./withAuditLog";

const DEMO_SHOP = "demo.myshopify.com";
const TOKEN_ID = "token_1";
const ECHO_SCHEMA = z.object({ message: z.string().min(1) });

function runTool(
  callback: (rawInput: unknown) => Promise<unknown>,
  rawInput: unknown,
  audit: AuditSink,
  mcpClient = "claude-code"
) {
  return runWithMcpContext(
    {
      auth: { shopId: DEMO_SHOP, shopDomain: DEMO_SHOP, tokenId: TOKEN_ID },
      mcpClient,
      audit,
    },
    () => callback(rawInput) as Promise<unknown>
  );
}

function buildAuditSpy(): { sink: AuditSink; entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    sink: async (entry) => {
      entries.push(entry);
    },
  };
}

describe("withAuditLog", () => {
  it("passes validated input and the shop to the handler", async () => {
    const audit = buildAuditSpy();
    const handler = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const callback = withAuditLog({ toolName: "echo", schema: ECHO_SCHEMA, handler });

    await runTool(callback, { message: "hello" }, audit.sink);

    expect(handler).toHaveBeenCalledWith(
      { message: "hello" },
      { auth: { shopId: DEMO_SHOP, shopDomain: DEMO_SHOP, tokenId: TOKEN_ID }, mcpClient: "claude-code" }
    );
  });

  it("writes one success audit entry naming the tool and the client", async () => {
    const audit = buildAuditSpy();
    const callback = withAuditLog({
      toolName: "echo",
      schema: ECHO_SCHEMA,
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });

    await runTool(callback, { message: "hello" }, audit.sink, "cursor");

    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      toolName: "echo",
      shopDomain: DEMO_SHOP,
      mcpTokenId: TOKEN_ID,
      mcpClient: "cursor",
      status: "success",
      errorMessage: null,
    });
    expect(typeof audit.entries[0]!.durationMs).toBe("number");
  });

  it("rejects input that fails the schema without calling the handler", async () => {
    const audit = buildAuditSpy();
    const handler = vi.fn();
    const callback = withAuditLog({ toolName: "echo", schema: ECHO_SCHEMA, handler });

    const result = (await runTool(callback, { message: "" }, audit.sink)) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };

    expect(handler).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).code).toBe(ERROR_CODES.VALIDATION_FAILED);
    expect(audit.entries[0]!.status).toBe("error");
  });

  it("surfaces a thrown McpToolError with its own code", async () => {
    const audit = buildAuditSpy();
    const callback = withAuditLog({
      toolName: "echo",
      schema: ECHO_SCHEMA,
      handler: async () => {
        throw new McpToolError(ERROR_CODES.DOWNSTREAM_ERROR, "upstream timed out");
      },
    });

    const result = (await runTool(callback, { message: "hello" }, audit.sink)) as {
      content: Array<{ text: string }>;
    };

    expect(JSON.parse(result.content[0]!.text).code).toBe(ERROR_CODES.DOWNSTREAM_ERROR);
    expect(audit.entries[0]!.errorMessage).toBe("upstream timed out");
  });

  it("wraps an unexpected throw rather than crashing the request", async () => {
    const audit = buildAuditSpy();
    const callback = withAuditLog({
      toolName: "echo",
      schema: ECHO_SCHEMA,
      handler: async () => {
        throw new Error("null is not an object");
      },
    });

    const result = (await runTool(callback, { message: "hello" }, audit.sink)) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).code).toBe(ERROR_CODES.DOWNSTREAM_ERROR);
    expect(audit.entries[0]!.errorMessage).toBe("null is not an object");
  });

  it("survives a handler that throws a non-Error", async () => {
    const audit = buildAuditSpy();
    const callback = withAuditLog({
      toolName: "echo",
      schema: ECHO_SCHEMA,
      handler: async () => {
        throw "boom";
      },
    });

    const result = (await runTool(callback, { message: "hello" }, audit.sink)) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).code).toBe(ERROR_CODES.DOWNSTREAM_ERROR);
    expect(audit.entries[0]!.errorMessage).toBe("boom");
    expect(audit.entries).toHaveLength(1);
  });

  it("still returns the result when the audit write fails", async () => {
    const failingSink: AuditSink = async () => {
      throw new Error("database unreachable");
    };
    const callback = withAuditLog({
      toolName: "echo",
      schema: ECHO_SCHEMA,
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });

    const result = (await runTool(callback, { message: "hello" }, failingSink)) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe("ok");
  });

  it("appends the narration line to a successful result, after the audit write", async () => {
    const audit = buildAuditSpy();
    const callback = withAuditLog({
      toolName: "echo",
      schema: ECHO_SCHEMA,
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
      narrate: (toolName) => `Say that this came from the ${toolName} tool.`,
    });

    const result = (await runTool(callback, { message: "hello" }, audit.sink)) as {
      content: Array<{ text: string }>;
    };

    expect(result.content).toHaveLength(2);
    expect(result.content[1]!.text).toBe("Say that this came from the echo tool.");
    expect((audit.entries[0]!.output as { content: unknown[] }).content).toHaveLength(1);
  });

  it("does not narrate a failure", async () => {
    const audit = buildAuditSpy();
    const callback = withAuditLog({
      toolName: "echo",
      schema: ECHO_SCHEMA,
      handler: async () => {
        throw new McpToolError(ERROR_CODES.DOWNSTREAM_ERROR, "upstream timed out");
      },
      narrate: (toolName) => `Say that this came from the ${toolName} tool.`,
    });

    const result = (await runTool(callback, { message: "hello" }, audit.sink)) as {
      content: Array<{ text: string }>;
    };

    expect(result.content).toHaveLength(1);
  });

  it("falls back to the un-narrated result when narrate throws, keeping the success audit entry", async () => {
    const audit = buildAuditSpy();
    const callback = withAuditLog({
      toolName: "echo",
      schema: ECHO_SCHEMA,
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
      narrate: () => {
        throw new Error("narrate blew up");
      },
    });

    const result = (await runTool(callback, { message: "hello" }, audit.sink)) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.text).toBe("ok");
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]!.status).toBe("success");
  });

  it("refuses to run outside an authenticated request and logs nothing", async () => {
    const audit = buildAuditSpy();
    const callback = withAuditLog({
      toolName: "echo",
      schema: ECHO_SCHEMA,
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });

    const result = (await callback({ message: "hello" })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).code).toBe(ERROR_CODES.NOT_AUTHENTICATED);
    expect(audit.entries).toHaveLength(0);
  });
});
