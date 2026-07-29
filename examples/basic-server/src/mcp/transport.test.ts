import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AuditEntry, AuditSink } from "../audit";
import { createMcpHandler } from "./transport";

const DEMO_SHOP = "demo.myshopify.com";
const TOKEN_ID = "token_1";
const MCP_ACCEPT = "application/json, text/event-stream";

function buildApp(audit: AuditSink, shopDomain = DEMO_SHOP) {
  const app = express();
  app.use(express.json());
  app.post(
    "/mcp",
    (req, _res, next) => {
      req.mcp = { shopId: shopDomain, shopDomain, tokenId: TOKEN_ID };
      next();
    },
    createMcpHandler({ audit })
  );
  return app;
}

/** The transport answers with SSE by default; a JSON body comes back when it chooses to. */
function readJsonRpc(response: request.Response): { result?: Record<string, unknown>; error?: unknown } {
  const contentType = String(response.headers["content-type"] ?? "");
  if (contentType.includes("application/json")) return response.body;

  const dataLine = response.text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error(`no JSON-RPC payload in response: ${response.text}`);
  return JSON.parse(dataLine.slice("data: ".length));
}

function post(app: express.Express, body: unknown, headers: Record<string, string> = {}) {
  return request(app)
    .post("/mcp")
    .set("Accept", MCP_ACCEPT)
    .set(headers)
    .send(body as object);
}

describe("createMcpHandler", () => {
  it("answers an initialize handshake", async () => {
    const response = await post(buildApp(vi.fn().mockResolvedValue(undefined)), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });

    expect(response.status).toBe(200);
    expect(readJsonRpc(response).result).toMatchObject({ serverInfo: { name: "basic-server" } });
  });

  it("lists both demo tools", async () => {
    const response = await post(buildApp(vi.fn().mockResolvedValue(undefined)), {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    const tools = (readJsonRpc(response).result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual(["echo", "whoami"]);
  });

  it("gives a tool the shop from req.mcp, which the SDK never passes through", async () => {
    const response = await post(buildApp(vi.fn().mockResolvedValue(undefined), "other-store.myshopify.com"), {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
    });

    const result = readJsonRpc(response).result as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]!.text).shop).toBe("other-store.myshopify.com");
  });

  it("records the calling client from the user-agent header", async () => {
    const entries: AuditEntry[] = [];
    const audit: AuditSink = async (entry) => {
      entries.push(entry);
    };

    await post(
      buildApp(audit),
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "echo", arguments: { message: "hi" } } },
      { "User-Agent": "claude-code/2.1.0 (external, cli)" }
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ toolName: "echo", mcpClient: "claude-code", status: "success" });
  });

  it("refuses a request that reached it without authentication", async () => {
    const app = express();
    app.use(express.json());
    app.post("/mcp", createMcpHandler({ audit: vi.fn().mockResolvedValue(undefined) }));

    const response = await request(app)
      .post("/mcp")
      .set("Accept", MCP_ACCEPT)
      .send({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} });

    expect(response.status).toBe(401);
  });
});
