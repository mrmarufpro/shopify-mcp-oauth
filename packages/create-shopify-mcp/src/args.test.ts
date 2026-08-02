import { describe, expect, it } from "vitest";
import { HELP_TEXT, parseArgs } from "./args";

const PROJECT_DIR = "my-mcp";

describe("parseArgs", () => {
  it("reads the target directory from the first positional argument", () => {
    expect(parseArgs([PROJECT_DIR]).targetDir).toBe(PROJECT_DIR);
  });

  it("leaves the target directory null when none was given", () => {
    expect(parseArgs([]).targetDir).toBeNull();
  });

  it("reads a storage choice from --storage", () => {
    expect(parseArgs([PROJECT_DIR, "--storage", "memory"]).storage).toBe("memory");
  });

  it("reads a storage choice from --storage=", () => {
    expect(parseArgs([PROJECT_DIR, "--storage=prisma"]).storage).toBe("prisma");
  });

  it("leaves the storage choice null so the caller can prompt", () => {
    expect(parseArgs([PROJECT_DIR]).storage).toBeNull();
  });

  it("rejects an unknown storage choice by name", () => {
    expect(() => parseArgs([PROJECT_DIR, "--storage", "mysql"])).toThrow(/mysql/);
  });

  it("enables git by default and lets --no-git turn it off", () => {
    expect(parseArgs([PROJECT_DIR]).git).toBe(true);
    expect(parseArgs([PROJECT_DIR, "--no-git"]).git).toBe(false);
  });

  it("recognizes --help and -h", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("recognizes --version and -v", () => {
    expect(parseArgs(["--version"]).version).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
  });

  it("names an unknown flag rather than ignoring it", () => {
    expect(() => parseArgs([PROJECT_DIR, "--force"])).toThrow(/--force/);
  });
});

describe("HELP_TEXT", () => {
  it("shows the invocation everyone will copy", () => {
    expect(HELP_TEXT).toContain("npx create-shopify-mcp my-mcp");
  });

  it("documents both storage variants", () => {
    expect(HELP_TEXT).toContain("prisma");
    expect(HELP_TEXT).toContain("memory");
  });
});
