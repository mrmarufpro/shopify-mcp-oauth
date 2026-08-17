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

  it("rejects the retired --storage flag by name rather than ignoring it", () => {
    expect(() => parseArgs([PROJECT_DIR, "--storage=prisma"])).toThrow(/--storage/);
  });

  it("refuses a second positional argument", () => {
    expect(() => parseArgs([PROJECT_DIR, "extra"])).toThrow(/extra/);
  });
});

describe("HELP_TEXT", () => {
  it("shows the invocation everyone will copy", () => {
    expect(HELP_TEXT).toContain("npx create-shopify-mcp my-mcp");
  });

  it("offers no storage choice — there is only one template", () => {
    expect(HELP_TEXT).not.toContain("--storage");
  });
});
