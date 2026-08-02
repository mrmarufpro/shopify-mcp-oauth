import { existsSync } from "node:fs";
import { cp, rename } from "node:fs/promises";
import path from "node:path";

export const EXCLUDED_ENTRIES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".env",
  ".DS_Store",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
]);

export async function copyTemplate(sourceDir: string, targetDir: string): Promise<void> {
  await cp(sourceDir, targetDir, {
    recursive: true,
    filter: (entry) => {
      const name = path.basename(entry);
      if (EXCLUDED_ENTRIES.has(name)) return false;
      return !name.endsWith(".tsbuildinfo");
    },
  });

  // npm strips a file named `.gitignore` from a published tarball, so the template ships it undotted.
  const undotted = path.join(targetDir, "gitignore");
  if (existsSync(undotted)) {
    await rename(undotted, path.join(targetDir, ".gitignore"));
  }
}
