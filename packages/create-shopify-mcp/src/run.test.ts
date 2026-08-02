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
  await mkdir(path.join(templateDir, "prisma"), { recursive: true });

  await writeFile(path.join(templateDir, "src", "storage.ts"), 'import { PrismaClient } from "@prisma/client";');
  await writeFile(path.join(templateDir, "src", "storage.memory.ts"), "export const storage = {};");
  await writeFile(path.join(templateDir, "prisma", "schema.prisma"), "model Session {}");
  await writeFile(path.join(templateDir, "docker-compose.yml"), "services: {}");
  await writeFile(path.join(templateDir, "gitignore"), "node_modules/\n");
  await writeFile(path.join(templateDir, ".env.example"), "MCP_HOST=https://your-tunnel.example.com\n");
  await writeFile(
    path.join(templateDir, "package.json"),
    JSON.stringify(
      {
        name: "basic-server",
        private: true,
        scripts: { dev: "tsx watch src/index.ts", postinstall: "prisma generate" },
        dependencies: { [OAUTH_PACKAGE]: "^0.1.0", "@prisma/client": "^6.19.3" },
        devDependencies: { prisma: "^6.19.3" },
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
  it("scaffolds a prisma project and reports success", async () => {
    const target = path.join(workspace, "my-mcp");
    const code = await run([target, "--storage", "prisma", "--no-git"], { templateDir });

    expect(code).toBe(0);
    expect(existsSync(path.join(target, "prisma", "schema.prisma"))).toBe(true);
    expect(JSON.parse(await readFile(path.join(target, "package.json"), "utf8")).name).toBe("my-mcp");
  });

  it("scaffolds a memory project without the prisma files", async () => {
    const target = path.join(workspace, "memory-mcp");
    await run([target, "--storage", "memory", "--no-git"], { templateDir });

    expect(existsSync(path.join(target, "prisma"))).toBe(false);
    expect(await readFile(path.join(target, "src", "storage.ts"), "utf8")).toContain('"./storage.memory"');
  });

  it("renames the undotted gitignore in the scaffolded project", async () => {
    const target = path.join(workspace, "ignored-mcp");
    await run([target, "--storage", "prisma", "--no-git"], { templateDir });

    expect(existsSync(path.join(target, ".gitignore"))).toBe(true);
  });

  it("asks for the storage choice only when --storage was omitted", async () => {
    const prompt = vi.fn().mockResolvedValue("memory" as const);

    await run([path.join(workspace, "asked"), "--no-git"], { templateDir, promptImpl: prompt });
    expect(prompt).toHaveBeenCalledTimes(1);

    await run([path.join(workspace, "not-asked"), "--storage", "prisma", "--no-git"], {
      templateDir,
      promptImpl: prompt,
    });
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("prints the help text and exits cleanly", async () => {
    const code = await run(["--help"], { templateDir });

    expect(code).toBe(0);
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain("npx create-shopify-mcp my-mcp");
  });

  it("fails with a usage message when no directory was given", async () => {
    await expect(run(["--storage", "memory"], { templateDir })).rejects.toThrow(/directory/i);
  });

  it("refuses to scaffold over an existing project", async () => {
    const target = path.join(workspace, "occupied");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "README.md"), "mine");

    await expect(run([target, "--storage", "memory", "--no-git"], { templateDir })).rejects.toThrow(/not empty/);
  });
});
