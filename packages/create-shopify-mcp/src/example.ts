export const EXAMPLE_REPO = { owner: "mrmarufpro", repo: "shopify-mcp-oauth" } as const;

/** Used when the repository has no GitHub release to pin to yet. */
export const FALLBACK_REF = "main";

const GITHUB_ORIGIN = "https://github.com";

export type RefResolution = { kind: "explicit"; ref: string } | { kind: "latest-release" } | { kind: "default-branch" };

export interface ExampleTarget {
  owner: string;
  repo: string;
  /** Path within the repository; "" means the repository root. */
  subpath: string;
  ref: RefResolution;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function parseExampleTarget(value: string, examplePath?: string): ExampleTarget {
  const url = parseUrl(value);

  if (url === null) {
    return {
      ...EXAMPLE_REPO,
      subpath: `examples/${value}`,
      ref: { kind: "latest-release" },
    };
  }

  if (url.origin !== GITHUB_ORIGIN) {
    throw new Error(`Only GitHub URLs are supported, so ${value} cannot be used as an example.`);
  }

  const [, owner, repo, kind, refSegment, ...rest] = url.pathname.split("/");

  if (!owner || !repo) {
    throw new Error(`${value} is not a GitHub repository URL.`);
  }

  // A repository whose whole purpose is to be an example, with or without a trailing slash.
  if (kind === undefined || (kind === "" && refSegment === undefined)) {
    return {
      owner,
      repo,
      subpath: examplePath?.replace(/^\//, "") ?? "",
      ref: { kind: "default-branch" },
    };
  }

  if (kind !== "tree" || !refSegment) {
    throw new Error(`${value} is not a GitHub tree URL. Link to a branch or tag with /tree/.`);
  }

  const subpath = examplePath ? examplePath.replace(/^\//, "") : rest.join("/");
  // With an explicit --example-path, everything before that path belongs to the branch name.
  const combined = [refSegment, ...rest].join("/").replace(/\/$/, "");
  const suffix = `/${subpath}`;
  const ref = examplePath && combined.endsWith(suffix) ? combined.slice(0, -suffix.length) : refSegment;

  return { owner, repo, subpath, ref: { kind: "explicit", ref } };
}
