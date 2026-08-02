import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.join(packageRoot, "..", "..");
const sourceDir = path.join(repoRoot, "examples", "basic-server");
const templateDir = path.join(packageRoot, "templates", "default");
const oauthManifest = path.join(repoRoot, "packages", "shopify-mcp-oauth", "package.json");

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

const TEMPLATE_GITIGNORE = `node_modules/
dist/
coverage/
*.tsbuildinfo
.env
.DS_Store
`;

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function main() {
  const { version } = await readJson(oauthManifest);

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

  const manifestFile = path.join(templateDir, "package.json");
  const manifest = await readJson(manifestFile);

  const specifier = manifest.dependencies?.["shopify-mcp-oauth"];
  if (!specifier) {
    throw new Error("examples/basic-server does not depend on shopify-mcp-oauth — nothing to resolve.");
  }
  manifest.dependencies["shopify-mcp-oauth"] = `^${version}`;
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  // npm strips a file named .gitignore from a published tarball; the CLI re-dots it on copy.
  await writeFile(path.join(templateDir, "gitignore"), TEMPLATE_GITIGNORE);

  console.log(`Synced examples/basic-server → templates/default (shopify-mcp-oauth ^${version})`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
