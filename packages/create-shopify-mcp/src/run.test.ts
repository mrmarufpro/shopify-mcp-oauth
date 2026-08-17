import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./run";

const OAUTH_PACKAGE = "shopify-mcp-oauth";

let workspace: string;
let templateDir: string;

async function buildFakeTemplate(): Promise<void> {
  await mkdir(path.join(templateDir, "src"), { recursive: true });

  await writeFile(path.join(templateDir, "src", "index.ts"), 'import { createApp } from "./app";');
  await writeFile(path.join(templateDir, "src", "app.ts"), "export function createApp() {}");
  await writeFile(path.join(templateDir, "src", "tools.ts"), "export function buildMcpServer() {}");
  await writeFile(path.join(templateDir, "gitignore"), "node_modules/\n");
  await writeFile(path.join(templateDir, ".env.example"), "MCP_HOST=https://your-tunnel.example.com\n");
  await writeFile(
    path.join(templateDir, "package.json"),
    JSON.stringify(
      {
        name: "basic-server",
        private: true,
        scripts: { dev: "tsx watch --env-file=.env src/index.ts" },
        dependencies: { [OAUTH_PACKAGE]: "^0.1.0" },
      },
      null,
      2
    )
  );
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "create-shopify-mcp-run-"));
  templateDir = path.join(workspace, "template");
  await buildFakeTemplate();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(workspace, { recursive: true, force: true });
});

describe("run", () => {
  it("scaffolds a project and reports success", async () => {
    const target = path.join(workspace, "my-mcp");
    const code = await run([target, "--no-git"], { templateDir });

    expect(code).toBe(0);
    expect(existsSync(path.join(target, "src", "tools.ts"))).toBe(true);
    expect(JSON.parse(await readFile(path.join(target, "package.json"), "utf8")).name).toBe("my-mcp");
  });

  it("renames the undotted gitignore in the scaffolded project", async () => {
    const target = path.join(workspace, "ignored-mcp");
    await run([target, "--no-git"], { templateDir });

    expect(existsSync(path.join(target, ".gitignore"))).toBe(true);
    expect(existsSync(path.join(target, "gitignore"))).toBe(false);
  });

  it("scaffolds without prompting for anything", async () => {
    const target = path.join(workspace, "unprompted");
    await expect(run([target, "--no-git"], { templateDir })).resolves.toBe(0);
  });

  it("prints the help text and exits cleanly", async () => {
    const code = await run(["--help"], { templateDir });

    expect(code).toBe(0);
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain("npx create-shopify-mcp my-mcp");
  });

  it("fails with a usage message when no directory was given", async () => {
    await expect(run(["--no-git"], { templateDir })).rejects.toThrow(/directory/i);
  });

  it("refuses to scaffold over an existing project", async () => {
    const target = path.join(workspace, "occupied");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "README.md"), "mine");

    await expect(run([target, "--no-git"], { templateDir })).rejects.toThrow(/not empty/);
  });
});
