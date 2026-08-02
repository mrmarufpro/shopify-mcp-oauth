import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyTemplate } from "./copy";

let workspace: string;
let source: string;
let target: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "create-shopify-mcp-copy-"));
  source = path.join(workspace, "template");
  target = path.join(workspace, "output");

  await mkdir(path.join(source, "src", "tools"), { recursive: true });
  await mkdir(path.join(source, "node_modules", "left-pad"), { recursive: true });
  await mkdir(path.join(source, "dist"), { recursive: true });

  await writeFile(path.join(source, "package.json"), '{ "name": "basic-server" }');
  await writeFile(path.join(source, "gitignore"), "node_modules/\ndist/\n.env\n");
  await writeFile(path.join(source, ".env"), "SHOPIFY_API_SECRET=real-secret");
  await writeFile(path.join(source, "tsconfig.tsbuildinfo"), "{}");
  await writeFile(path.join(source, "src", "tools", "echo.ts"), "export const echoTool = {};");
  await writeFile(path.join(source, "node_modules", "left-pad", "index.js"), "module.exports = 1;");
  await writeFile(path.join(source, "dist", "index.js"), "console.log(1);");
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("copyTemplate", () => {
  it("copies source files, including nested ones", async () => {
    await copyTemplate(source, target);
    expect(await readFile(path.join(target, "src", "tools", "echo.ts"), "utf8")).toContain("echoTool");
  });

  it("renames the undotted gitignore that npm would otherwise strip", async () => {
    await copyTemplate(source, target);
    expect(existsSync(path.join(target, "gitignore"))).toBe(false);
    expect(await readFile(path.join(target, ".gitignore"), "utf8")).toContain("node_modules/");
  });

  it("never copies node_modules", async () => {
    await copyTemplate(source, target);
    expect(existsSync(path.join(target, "node_modules"))).toBe(false);
  });

  it("never copies build output", async () => {
    await copyTemplate(source, target);
    expect(existsSync(path.join(target, "dist"))).toBe(false);
  });

  it("never copies a .env, which would leak the template author's secrets", async () => {
    await copyTemplate(source, target);
    expect(existsSync(path.join(target, ".env"))).toBe(false);
  });

  it("never copies tsbuildinfo files", async () => {
    await copyTemplate(source, target);
    expect(existsSync(path.join(target, "tsconfig.tsbuildinfo"))).toBe(false);
  });
});
