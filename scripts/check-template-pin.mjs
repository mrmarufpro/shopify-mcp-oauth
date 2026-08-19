import { readFile } from "node:fs/promises";

const read = async (file) => JSON.parse(await readFile(file, "utf8"));

const OAUTH_PACKAGE = "shopify-mcp-oauth";

const example = await read("examples/basic-server/package.json");
const template = await read("packages/create-shopify-mcp/templates/default/package.json");

const fail = (message) => {
  console.error(`✗ ${message}`);
  console.error("  Run `pnpm sync:template` and check packages/create-shopify-mcp/scripts/sync-template.mjs.");
  process.exit(1);
};

const expected = example.dependencies?.[OAUTH_PACKAGE];
const actual = template.dependencies?.[OAUTH_PACKAGE];

// The example is the source of truth -- sync-template copies it verbatim rather than rewriting the
// specifier, so anything but equality here means the sync did not run, ran against a different
// source, or grew a rewriting step that nothing else in the repository expects.
if (!expected) fail(`examples/basic-server does not depend on ${OAUTH_PACKAGE}`);
if (actual !== expected) fail(`template pins ${OAUTH_PACKAGE} at ${actual ?? "(nothing)"}, expected ${expected}`);

// Checked separately because the equality above passes when BOTH sides carry it. A workspace
// specifier resolves only inside this repository, so a scaffolded project fails at install with an
// unknown-protocol error; the CLI refuses such a manifest at scaffold time (see
// packages/create-shopify-mcp/src/packageJson.ts) and this catches it a release earlier. Covers
// devDependencies too, exactly as that check does.
const specs = { ...(template.dependencies ?? {}), ...(template.devDependencies ?? {}) };
const unresolved = Object.entries(specs)
  .filter(([, spec]) => typeof spec === "string" && spec.startsWith("workspace:"))
  .map(([name]) => name);

if (unresolved.length > 0)
  fail(`template pins ${unresolved.join(", ")} to a workspace version, which cannot be scaffolded`);

console.log(`✓ template pins ${OAUTH_PACKAGE} at ${actual}, matching the example`);
