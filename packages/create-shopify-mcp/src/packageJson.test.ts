import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rewritePackageJson, toPackageName } from "./packageJson";

const OAUTH_PACKAGE = "shopify-mcp-oauth";

let workspace: string;

async function writeTemplatePackageJson(overrides: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    path.join(workspace, "package.json"),
    JSON.stringify(
      {
        name: "basic-server",
        version: "0.1.0",
        private: true,
        dependencies: { [OAUTH_PACKAGE]: "^0.1.0", express: "^5.2.1" },
        devDependencies: { vitest: "^2.1.0" },
        ...overrides,
      },
      null,
      2
    )
  );
}

async function readTemplatePackageJson(): Promise<Record<string, never>> {
  return JSON.parse(await readFile(path.join(workspace, "package.json"), "utf8"));
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "create-shopify-mcp-pkg-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("toPackageName", () => {
  it("uses the directory's own name, not the whole path", () => {
    expect(toPackageName("/Users/someone/projects/My MCP")).toBe("my-mcp");
  });

  it("lowercases and dashes what npm would reject", () => {
    expect(toPackageName("Store_Tools!")).toBe("store-tools");
  });

  it("collapses repeated separators and trims them", () => {
    expect(toPackageName("--my--mcp--")).toBe("my-mcp");
  });

  it("falls back to a usable name when nothing survives", () => {
    expect(toPackageName("!!!")).toBe("shopify-mcp-server");
  });
});

describe("rewritePackageJson", () => {
  it("renames the package after the project", async () => {
    await writeTemplatePackageJson();
    await rewritePackageJson(workspace, { name: "my-mcp" });

    expect((await readTemplatePackageJson()).name).toBe("my-mcp");
  });

  it("leaves the resolved dependency version alone", async () => {
    await writeTemplatePackageJson();
    await rewritePackageJson(workspace, { name: "my-mcp" });

    expect((await readTemplatePackageJson()).dependencies[OAUTH_PACKAGE]).toBe("^0.1.0");
  });

  it("keeps the project private so nobody publishes their store's server by accident", async () => {
    await writeTemplatePackageJson();
    await rewritePackageJson(workspace, { name: "my-mcp" });

    expect((await readTemplatePackageJson()).private).toBe(true);
  });

  it("refuses a template that still carries a workspace specifier", async () => {
    await writeTemplatePackageJson({ dependencies: { [OAUTH_PACKAGE]: "workspace:*" } });

    await expect(rewritePackageJson(workspace, { name: "my-mcp" })).rejects.toThrow(new RegExp(OAUTH_PACKAGE));
  });

  it("ends the file with a newline, like every other tool writes it", async () => {
    await writeTemplatePackageJson();
    await rewritePackageJson(workspace, { name: "my-mcp" });

    expect(await readFile(path.join(workspace, "package.json"), "utf8")).toMatch(/\n$/);
  });
});
