import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareTarget } from "./target";

const PROJECT_NAME = "my-mcp";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "create-shopify-mcp-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("prepareTarget", () => {
  it("creates a directory that does not exist yet", async () => {
    const target = await prepareTarget(path.join(workspace, PROJECT_NAME));
    expect((await stat(target)).isDirectory()).toBe(true);
  });

  it("returns an absolute path even for a relative argument", async () => {
    const target = await prepareTarget(path.join(workspace, PROJECT_NAME));
    expect(path.isAbsolute(target)).toBe(true);
  });

  it("accepts an existing empty directory", async () => {
    const empty = path.join(workspace, "empty");
    await prepareTarget(empty);
    await expect(prepareTarget(empty)).resolves.toBe(empty);
  });

  it("refuses a directory that already has files in it", async () => {
    const occupied = path.join(workspace, "occupied");
    await prepareTarget(occupied);
    await writeFile(path.join(occupied, "README.md"), "mine");

    await expect(prepareTarget(occupied)).rejects.toThrow(/not empty/);
  });

  it("refuses a path that is a file", async () => {
    const file = path.join(workspace, "a-file");
    await writeFile(file, "");

    await expect(prepareTarget(file)).rejects.toThrow(/not a directory/);
  });
});
