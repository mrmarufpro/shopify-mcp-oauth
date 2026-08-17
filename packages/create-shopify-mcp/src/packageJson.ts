import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const FALLBACK_PACKAGE_NAME = "shopify-mcp-server";

export function toPackageName(input: string): string {
  const cleaned = path
    .basename(input)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return cleaned.length > 0 ? cleaned : FALLBACK_PACKAGE_NAME;
}

export async function rewritePackageJson(targetDir: string, options: { name: string }): Promise<void> {
  const file = path.join(targetDir, "package.json");
  const manifest = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;

  const specs = {
    ...((manifest.dependencies as Record<string, string> | undefined) ?? {}),
    ...((manifest.devDependencies as Record<string, string> | undefined) ?? {}),
  };
  // If a workspace specifier survives into the template, the pack script was skipped and the user's pnpm install will fail on an unknown protocol. Fail here instead with the actual cause.
  const unresolved = Object.entries(specs)
    .filter(([, spec]) => spec.startsWith("workspace:"))
    .map(([name]) => name);

  if (unresolved.length > 0) {
    throw new Error(
      `This example pins ${unresolved.join(", ")} to a workspace version, which only resolves ` +
        "inside its own repository. It cannot be scaffolded as-is."
    );
  }

  manifest.name = options.name;
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
}
