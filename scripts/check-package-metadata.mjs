import { readFile } from "node:fs/promises";

const REQUIRED = ["name", "version", "description", "license", "author", "repository", "homepage", "bugs", "keywords"];

const EXPECTED_AUTHOR = "Md Maruf Ahmed <maruffamd@gmail.com> (https://github.com/mrmarufpro)";
const EXPECTED_REPO_URL = "git+https://github.com/mrmarufpro/shopify-mcp-oauth.git";

const PACKAGES = ["shopify-mcp-oauth", "create-shopify-mcp"];

const problems = [];

for (const name of PACKAGES) {
  const dir = `packages/${name}`;
  const manifest = JSON.parse(await readFile(`${dir}/package.json`, "utf8"));

  for (const field of REQUIRED) {
    if (!manifest[field]) problems.push(`${name}: missing "${field}"`);
  }

  if (manifest.author !== EXPECTED_AUTHOR) {
    problems.push(`${name}: author is ${JSON.stringify(manifest.author)}, expected ${JSON.stringify(EXPECTED_AUTHOR)}`);
  }

  if (manifest.repository?.url !== EXPECTED_REPO_URL) {
    problems.push(`${name}: repository.url is ${JSON.stringify(manifest.repository?.url)}`);
  }

  if (manifest.repository?.directory !== dir) {
    problems.push(
      `${name}: repository.directory is ${JSON.stringify(manifest.repository?.directory)}, expected "${dir}"`
    );
  }

  if (!Array.isArray(manifest.keywords) || manifest.keywords.length < 5) {
    problems.push(`${name}: keywords should be an array of at least 5 entries`);
  }

  if (manifest.publishConfig?.access !== "public") {
    problems.push(`${name}: publishConfig.access must be "public"`);
  }
}

if (problems.length > 0) {
  console.error(problems.map((line) => `  ✗ ${line}`).join("\n"));
  process.exit(1);
}

console.log("✓ both package manifests carry the required npm metadata");
