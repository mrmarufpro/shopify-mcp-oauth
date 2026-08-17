import { describe, expect, it, vi } from "vitest";
import { EXAMPLE_REPO, parseExampleTarget, resolveRef } from "./example";

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

  it("takes the last occurrence of the path, not the first, when a segment repeats", () => {
    const target = parseExampleTarget("https://github.com/acme/templates/tree/a/b/c/b", "b");

    expect(target.ref).toEqual({ kind: "explicit", ref: "a/b/c" });
    expect(target.subpath).toBe("b");
  });

  it("treats regex characters in the path as literal text", () => {
    const target = parseExampleTarget("https://github.com/acme/templates/tree/main/mcp(starter)", "mcp(starter)");

    expect(target.ref).toEqual({ kind: "explicit", ref: "main" });
    expect(target.subpath).toBe("mcp(starter)");
  });

  it("does not crash on a path that would be an invalid regular expression", () => {
    const target = parseExampleTarget("https://github.com/acme/templates/tree/main/mcp[starter", "mcp[starter");

    expect(target.ref).toEqual({ kind: "explicit", ref: "main" });
  });
});

const RELEASE_TAG = "shopify-mcp-oauth@0.2.0";
const DEFAULT_BRANCH = "trunk";

function respondWith(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("resolveRef", () => {
  it("pins a named example to the newest release tag", async () => {
    const fetch = vi.fn().mockResolvedValue(respondWith(200, { tag_name: RELEASE_TAG }));

    const source = await resolveRef(parseExampleTarget(EXAMPLE_NAME), { fetch });

    expect(source.ref).toBe(RELEASE_TAG);
    expect(source.subpath).toBe(`examples/${EXAMPLE_NAME}`);
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain(
      `/repos/${EXAMPLE_REPO.owner}/${EXAMPLE_REPO.repo}/releases/latest`
    );
  });

  it("falls back to main when the repository has no releases yet", async () => {
    const fetch = vi.fn().mockResolvedValue(respondWith(404, { message: "Not Found" }));

    await expect(resolveRef(parseExampleTarget(EXAMPLE_NAME), { fetch })).resolves.toMatchObject({
      ref: "main",
    });
  });

  it("looks up the default branch for a bare repository URL", async () => {
    const fetch = vi.fn().mockResolvedValue(respondWith(200, { default_branch: DEFAULT_BRANCH }));

    const source = await resolveRef(parseExampleTarget(THIRD_PARTY_ROOT_URL), { fetch });

    expect(source.ref).toBe(DEFAULT_BRANCH);
  });

  it("asks GitHub nothing when the URL already names a ref", async () => {
    const fetch = vi.fn();

    const source = await resolveRef(parseExampleTarget(THIRD_PARTY_TREE_URL), { fetch });

    expect(source.ref).toBe("main");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a repository it cannot read rather than guessing a branch", async () => {
    const fetch = vi.fn().mockResolvedValue(respondWith(404, { message: "Not Found" }));

    await expect(resolveRef(parseExampleTarget(THIRD_PARTY_ROOT_URL), { fetch })).rejects.toThrow(
      /acme\/standalone-example/
    );
  });
});
