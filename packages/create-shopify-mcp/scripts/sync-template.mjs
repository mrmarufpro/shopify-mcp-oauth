import { cp, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.join(packageRoot, "..", "..");
const sourceDir = path.join(repoRoot, "examples", "basic-server");
const templateDir = path.join(packageRoot, "templates", "default");

const EXCLUDED_ENTRIES = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".env",
  ".DS_Store",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
]);

async function main() {
  await rm(templateDir, { recursive: true, force: true });
  await mkdir(templateDir, { recursive: true });

  await cp(sourceDir, templateDir, {
    recursive: true,
    filter: (entry) => {
      const name = path.basename(entry);
      if (EXCLUDED_ENTRIES.has(name)) return false;
      return !name.endsWith(".tsbuildinfo");
    },
  });

  // npm strips a file named .gitignore from a published tarball; the CLI re-dots it on copy.
  await rename(path.join(templateDir, ".gitignore"), path.join(templateDir, "gitignore"));

  console.log(`Synced examples/basic-server → templates/default`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
