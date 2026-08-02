import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyStorageChoice } from "./variant";

const PRISMA_PACKAGE = "@prisma/client";
const PRISMA_SESSION_PACKAGE = "@shopify/shopify-app-session-storage-prisma";

let project: string;

async function readManifest(): Promise<{
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}> {
  return JSON.parse(await readFile(path.join(project, "package.json"), "utf8"));
}

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), "create-shopify-mcp-variant-"));
  await mkdir(path.join(project, "src"), { recursive: true });
  await mkdir(path.join(project, "prisma", "migrations", "0_init"), { recursive: true });

  await writeFile(path.join(project, "src", "storage.ts"), 'import { PrismaClient } from "@prisma/client";');
  await writeFile(path.join(project, "src", "storage.memory.ts"), "export const storage = {};");
  await writeFile(
    path.join(project, "src", "storage.contract.test.ts"),
    'import { PrismaClient } from "@prisma/client";'
  );
  await writeFile(path.join(project, "prisma", "schema.prisma"), "model Session {}");
  await writeFile(path.join(project, "prisma", "migrations", "0_init", "migration.sql"), "CREATE TABLE x();");
  await writeFile(path.join(project, "docker-compose.yml"), "services: {}");
  await writeFile(
    path.join(project, ".env.example"),
    [
      "MCP_HOST=https://your-tunnel.example.com",
      "",
      "# Matches docker-compose.yml. Only used by the Prisma storage variant.",
      "DATABASE_URL=postgresql://mcp:mcp@localhost:5432/mcp",
      "",
    ].join("\n")
  );
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify(
      {
        name: "my-mcp",
        scripts: { dev: "tsx watch src/index.ts", postinstall: "prisma generate", "db:seed": "tsx prisma/seed.ts" },
        dependencies: { [PRISMA_PACKAGE]: "^6.19.3", [PRISMA_SESSION_PACKAGE]: "^9.0.1", express: "^5.2.1" },
        devDependencies: { prisma: "^6.19.3", vitest: "^2.1.0" },
      },
      null,
      2
    )
  );
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

describe("applyStorageChoice — prisma", () => {
  it("keeps the prisma schema, which is the template's default", async () => {
    await applyStorageChoice(project, "prisma");
    expect(existsSync(path.join(project, "prisma", "schema.prisma"))).toBe(true);
  });

  it("keeps the prisma storage wiring untouched", async () => {
    await applyStorageChoice(project, "prisma");
    expect(await readFile(path.join(project, "src", "storage.ts"), "utf8")).toContain("@prisma/client");
  });

  it("keeps the memory variant available as the test seam", async () => {
    await applyStorageChoice(project, "prisma");
    expect(existsSync(path.join(project, "src", "storage.memory.ts"))).toBe(true);
  });

  it("keeps the database contract test, which this variant can actually run", async () => {
    await applyStorageChoice(project, "prisma");
    expect(existsSync(path.join(project, "src", "storage.contract.test.ts"))).toBe(true);
  });
});

describe("applyStorageChoice — memory", () => {
  it("re-exports the memory storage so no other import has to change", async () => {
    await applyStorageChoice(project, "memory");
    const storage = await readFile(path.join(project, "src", "storage.ts"), "utf8");

    expect(storage).toContain('from "./storage.memory"');
    expect(storage).not.toContain("@prisma/client");
  });

  it("keeps storage.memory.ts, which is now the only implementation", async () => {
    await applyStorageChoice(project, "memory");
    expect(existsSync(path.join(project, "src", "storage.memory.ts"))).toBe(true);
  });

  it("removes the prisma directory and docker-compose", async () => {
    await applyStorageChoice(project, "memory");
    expect(existsSync(path.join(project, "prisma"))).toBe(false);
    expect(existsSync(path.join(project, "docker-compose.yml"))).toBe(false);
  });

  it("removes the database contract test, which would import a dependency that is gone", async () => {
    await applyStorageChoice(project, "memory");
    expect(existsSync(path.join(project, "src", "storage.contract.test.ts"))).toBe(false);
  });

  it("removes the database scripts, including postinstall", async () => {
    await applyStorageChoice(project, "memory");
    const { scripts } = await readManifest();

    expect(scripts.postinstall).toBeUndefined();
    expect(scripts["db:seed"]).toBeUndefined();
    expect(scripts.dev).toBe("tsx watch src/index.ts");
  });

  it("removes the prisma dependencies and leaves the rest alone", async () => {
    await applyStorageChoice(project, "memory");
    const manifest = await readManifest();

    expect(manifest.dependencies[PRISMA_PACKAGE]).toBeUndefined();
    expect(manifest.dependencies[PRISMA_SESSION_PACKAGE]).toBeUndefined();
    expect(manifest.devDependencies.prisma).toBeUndefined();
    expect(manifest.dependencies.express).toBe("^5.2.1");
    expect(manifest.devDependencies.vitest).toBe("^2.1.0");
  });

  it("drops DATABASE_URL and its comment from .env.example", async () => {
    await applyStorageChoice(project, "memory");
    const example = await readFile(path.join(project, ".env.example"), "utf8");

    expect(example).not.toContain("DATABASE_URL");
    expect(example).not.toContain("docker-compose.yml");
    expect(example).toContain("MCP_HOST=");
  });
});
