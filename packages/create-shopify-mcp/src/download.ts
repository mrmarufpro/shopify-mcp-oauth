import { Readable } from "node:stream";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { x } from "tar";
import type { ExampleSource, GitHubDeps } from "./example";

function contentsUrl(source: ExampleSource): string {
  const manifest = `${source.subpath ? `${source.subpath}/` : ""}package.json`;
  const repository = `${source.owner}/${source.repo}`;
  return `https://api.github.com/repos/${repository}/contents/${manifest}?ref=${encodeURIComponent(source.ref)}`;
}

export async function exampleExists(source: ExampleSource, deps: GitHubDeps): Promise<boolean> {
  try {
    const response = await deps.fetch(contentsUrl(source), { method: "HEAD" });
    return response.status === 200;
  } catch {
    // Offline or DNS failure: indistinguishable from a missing example to the caller.
    return false;
  }
}

export async function downloadAndExtract(source: ExampleSource, targetDir: string, deps: GitHubDeps): Promise<void> {
  const url = `https://codeload.github.com/${source.owner}/${source.repo}/tar.gz/${source.ref}`;
  const response = await deps.fetch(url);

  if (!response.ok) {
    throw new Error(`Could not download ${url} — GitHub answered ${response.status}.`);
  }
  if (!response.body) {
    throw new Error(`Could not download ${url} — GitHub answered ${response.status} with an empty body.`);
  }

  // GitHub names the archive root after the repository and ref. Read it off the first entry
  // rather than reconstructing it, so a renamed repository still extracts.
  let archiveRoot: string | null = null;

  await pipeline(
    Readable.fromWeb(response.body as import("stream/web").ReadableStream),
    x({
      cwd: targetDir,
      strip: source.subpath ? source.subpath.split("/").length + 1 : 1,
      filter: (entry: string) => {
        const posixPath = entry.split(path.sep).join(path.posix.sep);
        archiveRoot ??= posixPath.split(path.posix.sep)[0] ?? null;
        return posixPath.startsWith(`${archiveRoot}${source.subpath ? `/${source.subpath}/` : "/"}`);
      },
    })
  );
}
