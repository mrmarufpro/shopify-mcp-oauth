import { describe, expect, it } from "vitest";
import { HELP_TEXT, parseArgs } from "./args";

const PROJECT_DIR = "my-mcp";
const EXAMPLE_NAME = "basic-server";
const EXAMPLE_URL = "https://github.com/acme/templates";
const NESTED_PATH = "mcp/starter";

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

  it("leaves example null when the flag is absent", () => {
    expect(parseArgs([PROJECT_DIR]).example).toBeNull();
  });

  it("accepts the example as a separate argument or joined with an equals sign", () => {
    expect(parseArgs(["--example", EXAMPLE_NAME, PROJECT_DIR]).example).toBe(EXAMPLE_NAME);
    expect(parseArgs([`--example=${EXAMPLE_NAME}`, PROJECT_DIR]).example).toBe(EXAMPLE_NAME);
    expect(parseArgs(["-e", EXAMPLE_NAME, PROJECT_DIR]).example).toBe(EXAMPLE_NAME);
  });

  it("still finds the project directory after the example flag", () => {
    expect(parseArgs(["--example", EXAMPLE_NAME, PROJECT_DIR]).targetDir).toBe(PROJECT_DIR);
  });

  it("reads --example-path alongside --example", () => {
    const args = parseArgs(["--example", EXAMPLE_URL, "--example-path", NESTED_PATH, PROJECT_DIR]);
    expect(args.examplePath).toBe(NESTED_PATH);
  });

  it("refuses --example with nothing after it", () => {
    expect(() => parseArgs([PROJECT_DIR, "--example"])).toThrow(/--example/);
  });

  it("refuses an example value that is really the next flag", () => {
    expect(() => parseArgs(["--example", "--no-git", PROJECT_DIR])).toThrow(/--example/);
  });

  it("refuses --example-path on its own, which would silently do nothing", () => {
    expect(() => parseArgs(["--example-path", NESTED_PATH, PROJECT_DIR])).toThrow(/--example-path/);
  });
});

describe("HELP_TEXT", () => {
  it("shows the invocation everyone will copy", () => {
    expect(HELP_TEXT).toContain("npx create-shopify-mcp my-mcp");
  });

  it("offers no storage choice — there is only one template", () => {
    expect(HELP_TEXT).not.toContain("--storage");
  });

  it("documents the example flag people will copy from the README", () => {
    expect(HELP_TEXT).toContain("--example");
  });
});
