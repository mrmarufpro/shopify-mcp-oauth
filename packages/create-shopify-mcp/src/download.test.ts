import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { c } from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExampleSource } from "./example";
import { downloadAndExtract, exampleExists } from "./download";

const BASIC_SERVER: ExampleSource = {
  owner: "mrmarufpro",
  repo: "shopify-mcp-oauth",
  ref: "shopify-mcp-oauth@0.2.0",
  subpath: "examples/basic-server",
};

/** GitHub names the archive root after the repo and ref, and renames break naive filters. */
const ARCHIVE_ROOT = "shopify-mcp-oauth-renamed-after-the-fact";

let workspace: string;
let targetDir: string;

async function buildArchive(): Promise<Buffer> {
  const staging = path.join(workspace, "staging");
  const exampleDir = path.join(staging, ARCHIVE_ROOT, "examples", "basic-server");
  const otherDir = path.join(staging, ARCHIVE_ROOT, "examples", "other-example");

  await mkdir(path.join(exampleDir, "src"), { recursive: true });
  await mkdir(otherDir, { recursive: true });
  await writeFile(path.join(exampleDir, "package.json"), '{ "name": "basic-server" }\n');
  await writeFile(path.join(exampleDir, ".gitignore"), "node_modules/\n");
  await writeFile(path.join(exampleDir, "src", "index.ts"), "export {};\n");
  await writeFile(path.join(otherDir, "package.json"), '{ "name": "other-example" }\n');

  const chunks: Buffer[] = [];
  const stream = c({ gzip: true, cwd: staging }, [ARCHIVE_ROOT]);
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  await new Promise<void>((resolve, reject) => stream.on("end", () => resolve()).on("error", reject));

  return Buffer.concat(chunks);
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "create-shopify-mcp-download-"));
  targetDir = path.join(workspace, "target");
  await mkdir(targetDir, { recursive: true });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("exampleExists", () => {
  it("asks for the example's package.json at the resolved ref", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await expect(exampleExists(BASIC_SERVER, { fetch })).resolves.toBe(true);

    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toContain("/contents/examples/basic-server/package.json");
    expect(url).toContain(`ref=${encodeURIComponent(BASIC_SERVER.ref)}`);
    expect(init).toMatchObject({ method: "HEAD" });
  });

  it("reports a missing example rather than throwing", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));

    await expect(exampleExists(BASIC_SERVER, { fetch })).resolves.toBe(false);
  });

  it("treats an unreachable network as a missing example", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));

    await expect(exampleExists(BASIC_SERVER, { fetch })).resolves.toBe(false);
  });
});

describe("downloadAndExtract", () => {
  it("unpacks only the requested example, without its archive or example directory", async () => {
    const archive = await buildArchive();
    const fetch = vi.fn().mockResolvedValue(new Response(archive, { status: 200 }));

    await downloadAndExtract(BASIC_SERVER, targetDir, { fetch });

    expect(await readFile(path.join(targetDir, "package.json"), "utf8")).toContain("basic-server");
    expect(existsSync(path.join(targetDir, "src", "index.ts"))).toBe(true);
    expect(existsSync(path.join(targetDir, ".gitignore"))).toBe(true);
    expect(existsSync(path.join(targetDir, "examples"))).toBe(false);
    expect(existsSync(path.join(targetDir, ARCHIVE_ROOT))).toBe(false);
  });

  it("leaves every other example in the archive behind", async () => {
    const archive = await buildArchive();
    const fetch = vi.fn().mockResolvedValue(new Response(archive, { status: 200 }));

    await downloadAndExtract(BASIC_SERVER, targetDir, { fetch });

    expect(existsSync(path.join(targetDir, "other-example"))).toBe(false);
  });

  it("names the failing download when GitHub refuses it", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));

    await expect(downloadAndExtract(BASIC_SERVER, targetDir, { fetch })).rejects.toThrow(/500/);
  });
});
