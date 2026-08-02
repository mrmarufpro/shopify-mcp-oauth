import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initGit } from "./git";

const run = promisify(execFile);

/** Committing needs an identity; supply one so the test does not depend on the machine's git config. */
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Scaffold Test",
  GIT_AUTHOR_EMAIL: "scaffold@example.invalid",
  GIT_COMMITTER_NAME: "Scaffold Test",
  GIT_COMMITTER_EMAIL: "scaffold@example.invalid",
};

let project: string;

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), "create-shopify-mcp-git-"));
  await writeFile(path.join(project, "package.json"), '{ "name": "my-mcp" }');
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

describe("initGit", () => {
  it("initializes a repository", async () => {
    const result = await initGit(project, { ...process.env, ...GIT_IDENTITY });

    expect(result.initialized).toBe(true);
    expect(existsSync(path.join(project, ".git"))).toBe(true);
  });

  it("leaves exactly one commit containing the scaffold", async () => {
    const result = await initGit(project, { ...process.env, ...GIT_IDENTITY });
    expect(result.committed).toBe(true);

    const { stdout } = await run("git", ["log", "--oneline"], { cwd: project });
    expect(stdout.trim().split("\n")).toHaveLength(1);
  });

  it("reports failure rather than throwing when the directory is gone", async () => {
    await rm(project, { recursive: true, force: true });

    await expect(initGit(project, { ...process.env, ...GIT_IDENTITY })).resolves.toEqual({
      initialized: false,
      committed: false,
    });
  });
});
