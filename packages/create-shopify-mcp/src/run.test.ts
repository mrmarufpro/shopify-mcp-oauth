import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { c } from "tar";
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

const EXAMPLE_NAME = "basic-server";
const RELEASE_TAG = "shopify-mcp-oauth@0.2.0";

async function buildExampleArchive(): Promise<Buffer> {
  const staging = path.join(workspace, "archive-staging");
  const exampleDir = path.join(staging, "repo-root", "examples", EXAMPLE_NAME);

  await mkdir(path.join(exampleDir, "src"), { recursive: true });
  await writeFile(
    path.join(exampleDir, "package.json"),
    JSON.stringify({ name: EXAMPLE_NAME, dependencies: { [OAUTH_PACKAGE]: "latest" } }, null, 2)
  );
  await writeFile(path.join(exampleDir, ".env.example"), "MCP_HOST=\n");
  await writeFile(path.join(exampleDir, "src", "index.ts"), "export {};\n");

  const chunks: Buffer[] = [];
  const stream = c({ gzip: true, cwd: staging }, ["repo-root"]);
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  await new Promise<void>((resolve, reject) => stream.on("end", () => resolve()).on("error", reject));

  return Buffer.concat(chunks);
}

function fetchStubFor(archive: Buffer, options: { exists?: boolean } = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/releases/latest")) {
      return new Response(JSON.stringify({ tag_name: RELEASE_TAG }), { status: 200 });
    }
    if (url.includes("/contents/")) {
      return new Response(null, { status: options.exists === false ? 404 : 200 });
    }
    return new Response(archive, { status: 200 });
  });
}

describe("run --example", () => {
  it("downloads the named example at the newest release tag", async () => {
    const target = path.join(workspace, "fetched-mcp");
    const fetch = fetchStubFor(await buildExampleArchive());

    const code = await run(["--example", EXAMPLE_NAME, target, "--no-git"], { templateDir, fetch });

    expect(code).toBe(0);
    expect(existsSync(path.join(target, "src", "index.ts"))).toBe(true);
    expect(JSON.parse(await readFile(path.join(target, "package.json"), "utf8")).name).toBe("fetched-mcp");
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes(RELEASE_TAG))).toBe(true);
  });

  it("uses the bundled template and no network when --example says default", async () => {
    const target = path.join(workspace, "default-mcp");
    const fetch = vi.fn();

    await run(["--example", "default", target, "--no-git"], { templateDir, fetch });

    expect(existsSync(path.join(target, "src", "tools.ts"))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("names a misspelled example and leaves no directory behind", async () => {
    const target = path.join(workspace, "typo-mcp");
    const fetch = fetchStubFor(await buildExampleArchive(), { exists: false });

    await expect(run(["--example", "bsic-servr", target, "--no-git"], { templateDir, fetch })).rejects.toThrow(
      /bsic-servr/
    );
    expect(existsSync(target)).toBe(false);
  });
});
