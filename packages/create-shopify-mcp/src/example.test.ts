import { describe, expect, it } from "vitest";
import { EXAMPLE_REPO, parseExampleTarget } from "./example";

const EXAMPLE_NAME = "basic-server";
const THIRD_PARTY_TREE_URL = "https://github.com/acme/templates/tree/main/mcp/starter";
const THIRD_PARTY_ROOT_URL = "https://github.com/acme/standalone-example";

describe("parseExampleTarget", () => {
  it("reads a bare name as this repository's example, at whatever the latest release is", () => {
    const target = parseExampleTarget(EXAMPLE_NAME);

    expect(target.owner).toBe(EXAMPLE_REPO.owner);
    expect(target.repo).toBe(EXAMPLE_REPO.repo);
    expect(target.subpath).toBe(`examples/${EXAMPLE_NAME}`);
    expect(target.ref).toEqual({ kind: "latest-release" });
  });

  it("keeps slashes in a nested example name", () => {
    expect(parseExampleTarget("group/nested").subpath).toBe("examples/group/nested");
  });

  it("takes owner, repo, ref and path straight from a tree URL", () => {
    expect(parseExampleTarget(THIRD_PARTY_TREE_URL)).toEqual({
      owner: "acme",
      repo: "templates",
      subpath: "mcp/starter",
      ref: { kind: "explicit", ref: "main" },
    });
  });

  it("treats a bare repository URL as its root at the default branch", () => {
    expect(parseExampleTarget(THIRD_PARTY_ROOT_URL)).toEqual({
      owner: "acme",
      repo: "standalone-example",
      subpath: "",
      ref: { kind: "default-branch" },
    });
  });

  it("tolerates a trailing slash on a repository URL", () => {
    expect(parseExampleTarget(`${THIRD_PARTY_ROOT_URL}/`).ref).toEqual({ kind: "default-branch" });
  });

  it("lets --example-path carve the path out of a branch name containing slashes", () => {
    const target = parseExampleTarget("https://github.com/acme/templates/tree/bug/fix-1/mcp/starter", "mcp/starter");

    expect(target.ref).toEqual({ kind: "explicit", ref: "bug/fix-1" });
    expect(target.subpath).toBe("mcp/starter");
  });

  it("refuses a host that is not GitHub", () => {
    expect(() => parseExampleTarget("https://gitlab.com/acme/templates")).toThrow(/github/i);
  });

  it("refuses a GitHub URL that is neither a repository root nor a tree", () => {
    expect(() => parseExampleTarget("https://github.com/acme/templates/blob/main/README.md")).toThrow(/tree/);
  });
});
