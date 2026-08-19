import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { run } from "./run";

const OAUTH_PACKAGE = "shopify-mcp-oauth";
const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(packageRoot, "templates", "default");

let workspace: string;

beforeAll(async () => {
  execFileSync("node", ["scripts/sync-template.mjs"], { cwd: packageRoot, stdio: "pipe" });
  workspace = await mkdtemp(path.join(tmpdir(), "create-shopify-mcp-scaffold-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(async () => {
  vi.restoreAllMocks();
  await rm(workspace, { recursive: true, force: true });
});

async function scaffold(name: string): Promise<string> {
  const target = path.join(workspace, name);
  await run([target, "--no-git"], { templateDir });
  return target;
}

interface ScaffoldedManifest {
  name: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

async function readManifest(target: string): Promise<ScaffoldedManifest> {
  return JSON.parse(await readFile(path.join(target, "package.json"), "utf8"));
}

describe("scaffolding the real template", () => {
  it("produces a project with every file the README references", async () => {
    const target = await scaffold("basic-app");

    for (const file of [
      "package.json",
      "tsconfig.json",
      ".env.example",
      ".gitignore",
      "README.md",
      "src/index.ts",
      "src/app.ts",
      "src/tools.ts",
    ]) {
      expect(existsSync(path.join(target, file)), `missing ${file}`).toBe(true);
    }
  });

  it("names the project after its directory and resolves the oauth dependency", async () => {
    const manifest = await readManifest(await scaffold("named-app"));

    expect(manifest.name).toBe("named-app");
    expect(manifest.dependencies[OAUTH_PACKAGE]).toBe("latest");
  });

  it("leaves no workspace specifier anywhere in the scaffold", async () => {
    const manifest = await readManifest(await scaffold("clean-app"));

    const specs = Object.values({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(specs.filter((spec: string) => spec.startsWith("workspace:"))).toEqual([]);
  });

  it("carries no secrets or build output from the working tree", async () => {
    const target = await scaffold("hygiene-app");

    expect(existsSync(path.join(target, ".env"))).toBe(false);
    expect(existsSync(path.join(target, "node_modules"))).toBe(false);
    expect(existsSync(path.join(target, "dist"))).toBe(false);
  });

  it("carries no database surface — the template is in-memory only", async () => {
    const target = await scaffold("in-memory-app");
    const manifest = await readManifest(target);

    expect(existsSync(path.join(target, "prisma"))).toBe(false);
    expect(existsSync(path.join(target, "docker-compose.yml"))).toBe(false);
    expect(manifest.dependencies["@prisma/client"]).toBeUndefined();
    expect(manifest.scripts.postinstall).toBeUndefined();
  });

  it("keeps every relative import in the scaffold pointing at a file that exists", async () => {
    const target = await scaffold("resolvable-app");

    for (const [file, imported] of [
      ["src/index.ts", "./app"],
      ["src/app.ts", "./tools"],
    ] as const) {
      expect(await readFile(path.join(target, file), "utf8")).toContain(imported);
      expect(existsSync(path.join(target, "src", `${imported.slice("./".length)}.ts`))).toBe(true);
    }
  });
});
