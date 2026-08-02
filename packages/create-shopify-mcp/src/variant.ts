import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StorageChoice } from "./args";

export const MEMORY_STORAGE_SHIM = `// In-memory variant: clients, tokens, and the demo session live in this process only.
// They are lost on restart, and a second instance will not see them.
export { auditSink, sessionStorage, storage } from "./storage.memory";
`;

const PRISMA_SCRIPTS = ["postinstall", "db:generate", "db:migrate", "db:migrate:dev", "db:seed"];
const PRISMA_DEPENDENCIES = ["@prisma/client", "@shopify/shopify-app-session-storage-prisma"];
const PRISMA_DEV_DEPENDENCIES = ["prisma"];

function stripDatabaseUrl(contents: string): string {
  const kept: string[] = [];

  for (const line of contents.split("\n")) {
    if (line.startsWith("DATABASE_URL")) {
      // Drop the comment block that introduced it, too.
      while (kept.length > 0 && kept[kept.length - 1]!.startsWith("#")) kept.pop();
      continue;
    }
    kept.push(line);
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

async function pruneManifest(targetDir: string): Promise<void> {
  const file = path.join(targetDir, "package.json");
  const manifest = JSON.parse(await readFile(file, "utf8")) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  for (const script of PRISMA_SCRIPTS) delete manifest.scripts?.[script];
  for (const dependency of PRISMA_DEPENDENCIES) delete manifest.dependencies?.[dependency];
  for (const dependency of PRISMA_DEV_DEPENDENCIES) delete manifest.devDependencies?.[dependency];

  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function applyStorageChoice(targetDir: string, choice: StorageChoice): Promise<void> {
  if (choice === "prisma") return;

  await writeFile(path.join(targetDir, "src", "storage.ts"), MEMORY_STORAGE_SHIM);
  await rm(path.join(targetDir, "prisma"), { recursive: true, force: true });
  await rm(path.join(targetDir, "docker-compose.yml"), { force: true });
  // Imports @prisma/client, which this variant just removed from the dependencies.
  await rm(path.join(targetDir, "src", "storage.contract.test.ts"), { force: true });
  await pruneManifest(targetDir);

  const envExample = path.join(targetDir, ".env.example");
  await writeFile(envExample, stripDatabaseUrl(await readFile(envExample, "utf8")));
}
