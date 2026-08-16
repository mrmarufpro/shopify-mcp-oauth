import { readFile } from "node:fs/promises";

const read = async (file) => JSON.parse(await readFile(file, "utf8"));

const oauth = await read("packages/shopify-mcp-oauth/package.json");
const template = await read("packages/create-shopify-mcp/templates/default/package.json");

const actual = template.dependencies?.["shopify-mcp-oauth"];
const expected = `^${oauth.version}`;

if (actual !== expected) {
  console.error(`✗ template pins shopify-mcp-oauth at ${actual ?? "(nothing)"}, expected ${expected}`);
  console.error("  Run `pnpm sync:template` and check packages/create-shopify-mcp/scripts/sync-template.mjs.");
  process.exit(1);
}

console.log(`✓ template pins shopify-mcp-oauth at ${actual}`);
