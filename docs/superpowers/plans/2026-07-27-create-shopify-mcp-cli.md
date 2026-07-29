# create-shopify-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `npx create-shopify-mcp my-mcp` — a scaffolder whose template *is* `examples/basic-server`, so the demo and the generated project cannot drift — plus the repository's README, storage-adapter guide, and CI.

**Architecture:** A prepack script copies `examples/basic-server` into `packages/create-shopify-mcp/templates/default`, substituting the published `shopify-mcp-oauth` version for the workspace specifier. At runtime the CLI validates the target directory, copies the template, rewrites `package.json`, applies the chosen storage variant, initializes git, and prints next steps. Every stage is a separate pure-ish function with its own test; the interactive prompt is the only part not exercised end to end.

**Tech Stack:** TypeScript (strict), `@clack/prompts`, Node `node:fs/promises` / `node:child_process`, tsup (ESM only), Vitest, GitHub Actions.

This is **plan 3 of 3**. Plans 1 and 2 must be complete: the CLI's template is plan 2's output, and CI runs plan 1's and plan 2's suites.

Spec: `docs/superpowers/specs/2026-07-27-shopify-mcp-oauth-boilerplate-design.md` §5–§7.

## Global Constraints

- Node ≥ 20. `package.json` sets `"engines": { "node": ">=20" }`.
- TypeScript `strict: true`. Build with tsup to **ESM only** — a CLI has no CJS consumers.
- Test runner is **Vitest**. Never invoke Jest.
- The CLI writes to the user's filesystem: every destructive step is guarded, and it never overwrites a
  non-empty directory.
- Formatting: double quotes, 120 print width, 2-space indent, trailing comma `es5`.
- Comments are minimal: only where the *why* is non-obvious (npm's `.gitignore` stripping, the
  workspace-specifier guard).
- Test data uses readable named constants referenced from both setup and assertion. Tests that touch
  the filesystem work inside `mkdtemp` directories and clean up after themselves.
- No app-specific names, no vendor names, no real credentials anywhere in the tree.
- `templates/` is generated and gitignored (plan 1 Task 1 already added the ignore rule); it is
  published because `package.json`'s `files` lists it explicitly.

---

## File Structure

```
packages/create-shopify-mcp/
  src/
    args.ts             parseArgs(argv) → CliArgs
    target.ts           prepareTarget(dir) → absolute path, refuses a non-empty directory
    copy.ts             copyTemplate(sourceDir, targetDir), exclusions, gitignore rename
    packageJson.ts      toPackageName(input), rewritePackageJson(dir, { name })
    variant.ts          applyStorageChoice(dir, choice)
    git.ts              initGit(dir, env?)
    nextSteps.ts        nextSteps(projectDir, choice) → string
    run.ts              run(argv) — prompt, then the pipeline above
    index.ts            bin entry, error handling, exit code
  scripts/
    sync-template.mjs   prepack: examples/basic-server → templates/default
  templates/default/    generated, gitignored, published
  package.json  tsconfig.json  tsup.config.ts  vitest.config.ts

docs/storage-adapters.md
README.md
.github/workflows/ci.yml
```

Each stage is its own file because each has its own failure mode worth testing in isolation: a bad
directory, a bad copy, a stale workspace specifier, a half-pruned variant.

---

## Locked Interfaces

Every task below consumes or produces from this set. Names here are authoritative — a later task using
a different spelling is a bug.

```ts
// src/args.ts
export type StorageChoice = "prisma" | "memory";
export interface CliArgs {
  targetDir: string | null;
  storage: StorageChoice | null;
  git: boolean;
  help: boolean;
  version: boolean;
}
export function parseArgs(argv: string[]): CliArgs;
export const HELP_TEXT: string;
```

```ts
// src/target.ts
export function prepareTarget(dir: string): Promise<string>;
```

```ts
// src/copy.ts
export const EXCLUDED_ENTRIES: ReadonlySet<string>;
export function copyTemplate(sourceDir: string, targetDir: string): Promise<void>;
```

```ts
// src/packageJson.ts
export function toPackageName(input: string): string;
export function rewritePackageJson(targetDir: string, options: { name: string }): Promise<void>;
```

```ts
// src/variant.ts
export const MEMORY_STORAGE_SHIM: string;
export function applyStorageChoice(targetDir: string, choice: StorageChoice): Promise<void>;
```

```ts
// src/git.ts
export interface GitResult {
  initialized: boolean;
  committed: boolean;
}
export function initGit(targetDir: string, env?: NodeJS.ProcessEnv): Promise<GitResult>;
```

```ts
// src/nextSteps.ts
export function nextSteps(projectDir: string, choice: StorageChoice): string;
```

```ts
// src/run.ts
export interface RunOptions {
  /** Overrides the bundled template location. Tests point this at a freshly synced directory. */
  templateDir?: string;
  /** Skips the interactive prompt when `--storage` was not passed. Tests always pass a choice. */
  promptImpl?: () => Promise<StorageChoice>;
}
export function run(argv: string[], options?: RunOptions): Promise<number>;
```

---

## Task 1: CLI package skeleton and argument parsing

**Files:**
- Create: `packages/create-shopify-mcp/package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`
- Create: `packages/create-shopify-mcp/src/args.ts`
- Test: `packages/create-shopify-mcp/src/args.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `StorageChoice`, `CliArgs`, `parseArgs`, `HELP_TEXT`

- [ ] **Step 1: Write the failing test**

`packages/create-shopify-mcp/src/args.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HELP_TEXT, parseArgs } from "./args";

const PROJECT_DIR = "my-mcp";

describe("parseArgs", () => {
  it("reads the target directory from the first positional argument", () => {
    expect(parseArgs([PROJECT_DIR]).targetDir).toBe(PROJECT_DIR);
  });

  it("leaves the target directory null when none was given", () => {
    expect(parseArgs([]).targetDir).toBeNull();
  });

  it("reads a storage choice from --storage", () => {
    expect(parseArgs([PROJECT_DIR, "--storage", "memory"]).storage).toBe("memory");
  });

  it("reads a storage choice from --storage=", () => {
    expect(parseArgs([PROJECT_DIR, "--storage=prisma"]).storage).toBe("prisma");
  });

  it("leaves the storage choice null so the caller can prompt", () => {
    expect(parseArgs([PROJECT_DIR]).storage).toBeNull();
  });

  it("rejects an unknown storage choice by name", () => {
    expect(() => parseArgs([PROJECT_DIR, "--storage", "mysql"])).toThrow(/mysql/);
  });

  it("enables git by default and lets --no-git turn it off", () => {
    expect(parseArgs([PROJECT_DIR]).git).toBe(true);
    expect(parseArgs([PROJECT_DIR, "--no-git"]).git).toBe(false);
  });

  it("recognizes --help and -h", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("recognizes --version and -v", () => {
    expect(parseArgs(["--version"]).version).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
  });

  it("names an unknown flag rather than ignoring it", () => {
    expect(() => parseArgs([PROJECT_DIR, "--force"])).toThrow(/--force/);
  });
});

describe("HELP_TEXT", () => {
  it("shows the invocation everyone will copy", () => {
    expect(HELP_TEXT).toContain("npx create-shopify-mcp my-mcp");
  });

  it("documents both storage variants", () => {
    expect(HELP_TEXT).toContain("prisma");
    expect(HELP_TEXT).toContain("memory");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter create-shopify-mcp test`
Expected: FAIL — the workspace package does not exist yet.

- [ ] **Step 3: Create the package files**

`packages/create-shopify-mcp/package.json`:

```json
{
  "name": "create-shopify-mcp",
  "version": "0.1.0",
  "description": "Scaffold an MCP server for a Shopify app, with OAuth login already wired",
  "license": "MIT",
  "type": "module",
  "engines": { "node": ">=20" },
  "bin": { "create-shopify-mcp": "./dist/index.js" },
  "files": ["dist", "templates"],
  "scripts": {
    "build": "tsup",
    "prepack": "node scripts/sync-template.mjs && tsup",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@clack/prompts": "^1.7.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsup": "^8.3.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  },
  "publishConfig": { "access": "public" }
}
```

`templates/` is gitignored but still published: npm includes anything listed in `files` even when git
ignores it.

`packages/create-shopify-mcp/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`packages/create-shopify-mcp/tsup.config.ts`:

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: false,
  clean: true,
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
});
```

The shebang comes from the banner, not from the source file — two shebangs would break the binary.

`packages/create-shopify-mcp/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
```

- [ ] **Step 4: Write `src/args.ts`**

```ts
export type StorageChoice = "prisma" | "memory";

export interface CliArgs {
  targetDir: string | null;
  storage: StorageChoice | null;
  git: boolean;
  help: boolean;
  version: boolean;
}

export const HELP_TEXT = `
Usage: npx create-shopify-mcp my-mcp [options]

Options:
  --storage <prisma|memory>  Storage variant. Prompts when omitted.
                             prisma  Postgres via Prisma, survives a restart
                             memory  in-process, single instance, lost on restart
  --no-git                   Skip git init
  -h, --help                 Show this message
  -v, --version              Show the version
`.trim();

const STORAGE_CHOICES: readonly StorageChoice[] = ["prisma", "memory"];

function toStorageChoice(value: string): StorageChoice {
  const choice = STORAGE_CHOICES.find((candidate) => candidate === value);
  if (!choice) {
    throw new Error(`Unknown storage "${value}". Choose one of: ${STORAGE_CHOICES.join(", ")}`);
  }
  return choice;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { targetDir: null, storage: null, git: true, help: false, version: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;

    if (argument === "--help" || argument === "-h") {
      args.help = true;
    } else if (argument === "--version" || argument === "-v") {
      args.version = true;
    } else if (argument === "--no-git") {
      args.git = false;
    } else if (argument === "--storage") {
      const value = argv[index + 1];
      if (!value) throw new Error("--storage needs a value: prisma or memory");
      args.storage = toStorageChoice(value);
      index += 1;
    } else if (argument.startsWith("--storage=")) {
      args.storage = toStorageChoice(argument.slice("--storage=".length));
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option ${argument}. Run with --help.`);
    } else if (args.targetDir === null) {
      args.targetDir = argument;
    } else {
      throw new Error(`Unexpected argument ${argument}. Only one project directory is supported.`);
    }
  }

  return args;
}
```

- [ ] **Step 5: Install and run the test to verify it passes**

Run: `pnpm install && pnpm --filter create-shopify-mcp test`
Expected: PASS, 12 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/create-shopify-mcp
git commit -m "feat(cli): scaffold the create-shopify-mcp package with argument parsing"
```

---

## Task 2: Target directory preparation

**Files:**
- Create: `packages/create-shopify-mcp/src/target.ts`
- Test: `packages/create-shopify-mcp/src/target.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `prepareTarget(dir): Promise<string>` — the absolute path, created if absent

- [ ] **Step 1: Write the failing test**

`packages/create-shopify-mcp/src/target.test.ts`:

```ts
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareTarget } from "./target";

const PROJECT_NAME = "my-mcp";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "create-shopify-mcp-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("prepareTarget", () => {
  it("creates a directory that does not exist yet", async () => {
    const target = await prepareTarget(path.join(workspace, PROJECT_NAME));
    expect((await stat(target)).isDirectory()).toBe(true);
  });

  it("returns an absolute path even for a relative argument", async () => {
    const target = await prepareTarget(path.join(workspace, PROJECT_NAME));
    expect(path.isAbsolute(target)).toBe(true);
  });

  it("accepts an existing empty directory", async () => {
    const empty = path.join(workspace, "empty");
    await prepareTarget(empty);
    await expect(prepareTarget(empty)).resolves.toBe(empty);
  });

  it("refuses a directory that already has files in it", async () => {
    const occupied = path.join(workspace, "occupied");
    await prepareTarget(occupied);
    await writeFile(path.join(occupied, "README.md"), "mine");

    await expect(prepareTarget(occupied)).rejects.toThrow(/not empty/);
  });

  it("refuses a path that is a file", async () => {
    const file = path.join(workspace, "a-file");
    await writeFile(file, "");

    await expect(prepareTarget(file)).rejects.toThrow(/not a directory/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter create-shopify-mcp test src/target.test.ts`
Expected: FAIL — cannot resolve `./target`.

- [ ] **Step 3: Write `src/target.ts`**

```ts
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

export async function prepareTarget(dir: string): Promise<string> {
  const absolute = path.resolve(dir);

  let entries: string[];
  try {
    entries = await readdir(absolute);
  } catch (thrown) {
    const error = thrown as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      await mkdir(absolute, { recursive: true });
      return absolute;
    }
    if (error.code === "ENOTDIR") {
      throw new Error(`${absolute} exists and is not a directory.`);
    }
    throw error;
  }

  if (entries.length > 0) {
    throw new Error(`${absolute} is not empty. Choose another directory or empty this one first.`);
  }
  return absolute;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter create-shopify-mcp test src/target.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/create-shopify-mcp/src/target.ts packages/create-shopify-mcp/src/target.test.ts
git commit -m "feat(cli): validate and prepare the target directory"
```

---

## Task 3: Template copy

**Files:**
- Create: `packages/create-shopify-mcp/src/copy.ts`
- Test: `packages/create-shopify-mcp/src/copy.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `EXCLUDED_ENTRIES`, `copyTemplate(sourceDir, targetDir)`

npm strips a file literally named `.gitignore` out of a published tarball. The template therefore
ships it as `gitignore`, and the copy renames it — the standard workaround, and the reason a
scaffolded project would otherwise arrive with no ignore file at all.

- [ ] **Step 1: Write the failing test**

`packages/create-shopify-mcp/src/copy.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyTemplate } from "./copy";

let workspace: string;
let source: string;
let target: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "create-shopify-mcp-copy-"));
  source = path.join(workspace, "template");
  target = path.join(workspace, "output");

  await mkdir(path.join(source, "src", "tools"), { recursive: true });
  await mkdir(path.join(source, "node_modules", "left-pad"), { recursive: true });
  await mkdir(path.join(source, "dist"), { recursive: true });

  await writeFile(path.join(source, "package.json"), '{ "name": "basic-server" }');
  await writeFile(path.join(source, "gitignore"), "node_modules/\ndist/\n.env\n");
  await writeFile(path.join(source, ".env"), "SHOPIFY_API_SECRET=real-secret");
  await writeFile(path.join(source, "tsconfig.tsbuildinfo"), "{}");
  await writeFile(path.join(source, "src", "tools", "echo.ts"), "export const echoTool = {};");
  await writeFile(path.join(source, "node_modules", "left-pad", "index.js"), "module.exports = 1;");
  await writeFile(path.join(source, "dist", "index.js"), "console.log(1);");
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("copyTemplate", () => {
  it("copies source files, including nested ones", async () => {
    await copyTemplate(source, target);
    expect(await readFile(path.join(target, "src", "tools", "echo.ts"), "utf8")).toContain("echoTool");
  });

  it("renames the undotted gitignore that npm would otherwise strip", async () => {
    await copyTemplate(source, target);
    expect(existsSync(path.join(target, "gitignore"))).toBe(false);
    expect(await readFile(path.join(target, ".gitignore"), "utf8")).toContain("node_modules/");
  });

  it("never copies node_modules", async () => {
    await copyTemplate(source, target);
    expect(existsSync(path.join(target, "node_modules"))).toBe(false);
  });

  it("never copies build output", async () => {
    await copyTemplate(source, target);
    expect(existsSync(path.join(target, "dist"))).toBe(false);
  });

  it("never copies a .env, which would leak the template author's secrets", async () => {
    await copyTemplate(source, target);
    expect(existsSync(path.join(target, ".env"))).toBe(false);
  });

  it("never copies tsbuildinfo files", async () => {
    await copyTemplate(source, target);
    expect(existsSync(path.join(target, "tsconfig.tsbuildinfo"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter create-shopify-mcp test src/copy.test.ts`
Expected: FAIL — cannot resolve `./copy`.

- [ ] **Step 3: Write `src/copy.ts`**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter create-shopify-mcp test src/copy.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/create-shopify-mcp/src/copy.ts packages/create-shopify-mcp/src/copy.test.ts
git commit -m "feat(cli): copy the template without build output or secrets"
```

---

## Task 4: package.json rewriting

**Files:**
- Create: `packages/create-shopify-mcp/src/packageJson.ts`
- Test: `packages/create-shopify-mcp/src/packageJson.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `toPackageName(input)`, `rewritePackageJson(targetDir, { name })`

The workspace-specifier guard is the important part. If `shopify-mcp-oauth` is still pinned to
`workspace:*` when a user runs `pnpm install`, they get an error naming a protocol they have never
heard of. Failing here instead names the actual problem: the template was published without running
the sync script.

- [ ] **Step 1: Write the failing test**

`packages/create-shopify-mcp/src/packageJson.test.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rewritePackageJson, toPackageName } from "./packageJson";

const OAUTH_PACKAGE = "shopify-mcp-oauth";

let workspace: string;

async function writeTemplatePackageJson(overrides: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    path.join(workspace, "package.json"),
    JSON.stringify(
      {
        name: "basic-server",
        version: "0.1.0",
        private: true,
        dependencies: { [OAUTH_PACKAGE]: "^0.1.0", express: "^5.2.1" },
        devDependencies: { vitest: "^2.1.0" },
        ...overrides,
      },
      null,
      2
    )
  );
}

async function readTemplatePackageJson(): Promise<Record<string, never>> {
  return JSON.parse(await readFile(path.join(workspace, "package.json"), "utf8"));
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "create-shopify-mcp-pkg-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("toPackageName", () => {
  it("uses the directory's own name, not the whole path", () => {
    expect(toPackageName("/Users/someone/projects/My MCP")).toBe("my-mcp");
  });

  it("lowercases and dashes what npm would reject", () => {
    expect(toPackageName("Store_Tools!")).toBe("store-tools");
  });

  it("collapses repeated separators and trims them", () => {
    expect(toPackageName("--my--mcp--")).toBe("my-mcp");
  });

  it("falls back to a usable name when nothing survives", () => {
    expect(toPackageName("!!!")).toBe("shopify-mcp-server");
  });
});

describe("rewritePackageJson", () => {
  it("renames the package after the project", async () => {
    await writeTemplatePackageJson();
    await rewritePackageJson(workspace, { name: "my-mcp" });

    expect((await readTemplatePackageJson()).name).toBe("my-mcp");
  });

  it("leaves the resolved dependency version alone", async () => {
    await writeTemplatePackageJson();
    await rewritePackageJson(workspace, { name: "my-mcp" });

    expect((await readTemplatePackageJson()).dependencies[OAUTH_PACKAGE]).toBe("^0.1.0");
  });

  it("keeps the project private so nobody publishes their store's server by accident", async () => {
    await writeTemplatePackageJson();
    await rewritePackageJson(workspace, { name: "my-mcp" });

    expect((await readTemplatePackageJson()).private).toBe(true);
  });

  it("refuses a template that still carries a workspace specifier", async () => {
    await writeTemplatePackageJson({ dependencies: { [OAUTH_PACKAGE]: "workspace:*" } });

    await expect(rewritePackageJson(workspace, { name: "my-mcp" })).rejects.toThrow(
      new RegExp(OAUTH_PACKAGE)
    );
  });

  it("ends the file with a newline, like every other tool writes it", async () => {
    await writeTemplatePackageJson();
    await rewritePackageJson(workspace, { name: "my-mcp" });

    expect(await readFile(path.join(workspace, "package.json"), "utf8")).toMatch(/\n$/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter create-shopify-mcp test src/packageJson.test.ts`
Expected: FAIL — cannot resolve `./packageJson`.

- [ ] **Step 3: Write `src/packageJson.ts`**

```ts
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
  const unresolved = Object.entries(specs)
    .filter(([, spec]) => spec.startsWith("workspace:"))
    .map(([name]) => name);

  if (unresolved.length > 0) {
    throw new Error(
      `Template still pins ${unresolved.join(", ")} to a workspace version. ` +
        "It was packed without running scripts/sync-template.mjs."
    );
  }

  manifest.name = options.name;
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter create-shopify-mcp test src/packageJson.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/create-shopify-mcp/src/packageJson.ts packages/create-shopify-mcp/src/packageJson.test.ts
git commit -m "feat(cli): rewrite the scaffolded package manifest"
```

---

## Task 5: Storage variant

**Files:**
- Create: `packages/create-shopify-mcp/src/variant.ts`
- Test: `packages/create-shopify-mcp/src/variant.test.ts`

**Interfaces:**
- Consumes: `StorageChoice` from `./args`
- Produces: `MEMORY_STORAGE_SHIM`, `applyStorageChoice(targetDir, choice)`

The template ships both storage files. The Prisma variant needs no changes at all — it is the
template's default. The memory variant replaces `src/storage.ts` with a one-line re-export of
`src/storage.memory.ts`, so no test or import anywhere else has to be rewritten, then strips the
Prisma files, scripts, dependencies, and the `DATABASE_URL` entry.

- [ ] **Step 1: Write the failing test**

`packages/create-shopify-mcp/src/variant.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter create-shopify-mcp test src/variant.test.ts`
Expected: FAIL — cannot resolve `./variant`.

- [ ] **Step 3: Write `src/variant.ts`**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter create-shopify-mcp test src/variant.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/create-shopify-mcp/src/variant.ts packages/create-shopify-mcp/src/variant.test.ts
git commit -m "feat(cli): apply the chosen storage variant to the scaffold"
```

---

## Task 6: Git initialization and next steps

**Files:**
- Create: `packages/create-shopify-mcp/src/git.ts`, `packages/create-shopify-mcp/src/nextSteps.ts`
- Test: `packages/create-shopify-mcp/src/git.test.ts`, `packages/create-shopify-mcp/src/nextSteps.test.ts`

**Interfaces:**
- Consumes: `StorageChoice` from `./args`
- Produces: `GitResult`, `initGit(targetDir, env?)`, `nextSteps(projectDir, choice)`

`initGit` never fails the scaffold. A machine without git, or with no configured commit identity,
still gets a working project — the caller reports what happened and moves on.

- [ ] **Step 1: Write the failing tests**

`packages/create-shopify-mcp/src/git.test.ts`:

```ts
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initGit } from "./git";

const run = promisify(execFile);

/** Committing needs an identity; supply one so the test does not depend on the machine's git config. */
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Scaffold Test",
  GIT_AUTHOR_EMAIL: "scaffold@example.invalid",
  GIT_COMMITTER_NAME: "Scaffold Test",
  GIT_COMMITTER_EMAIL: "scaffold@example.invalid",
};

let project: string;

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), "create-shopify-mcp-git-"));
  await writeFile(path.join(project, "package.json"), '{ "name": "my-mcp" }');
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

describe("initGit", () => {
  it("initializes a repository", async () => {
    const result = await initGit(project, { ...process.env, ...GIT_IDENTITY });

    expect(result.initialized).toBe(true);
    expect(existsSync(path.join(project, ".git"))).toBe(true);
  });

  it("leaves exactly one commit containing the scaffold", async () => {
    const result = await initGit(project, { ...process.env, ...GIT_IDENTITY });
    expect(result.committed).toBe(true);

    const { stdout } = await run("git", ["log", "--oneline"], { cwd: project });
    expect(stdout.trim().split("\n")).toHaveLength(1);
  });

  it("reports failure rather than throwing when the directory is gone", async () => {
    await rm(project, { recursive: true, force: true });

    await expect(initGit(project, { ...process.env, ...GIT_IDENTITY })).resolves.toEqual({
      initialized: false,
      committed: false,
    });
  });
});
```

`packages/create-shopify-mcp/src/nextSteps.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { nextSteps } from "./nextSteps";

const PROJECT_DIR = "my-mcp";

describe("nextSteps", () => {
  it("starts by entering the project and installing", () => {
    const steps = nextSteps(PROJECT_DIR, "prisma");
    expect(steps).toContain(`cd ${PROJECT_DIR}`);
    expect(steps).toContain("pnpm install");
  });

  it("tells the Prisma user to start the database, migrate, and seed", () => {
    const steps = nextSteps(PROJECT_DIR, "prisma");
    expect(steps).toContain("docker compose up -d");
    expect(steps).toContain("pnpm db:migrate");
    expect(steps).toContain("pnpm db:seed");
  });

  it("omits the database steps for the memory variant", () => {
    const steps = nextSteps(PROJECT_DIR, "memory");
    expect(steps).not.toContain("docker compose");
    expect(steps).not.toContain("db:migrate");
  });

  it("warns the memory user that tokens vanish and a second instance breaks login", () => {
    const steps = nextSteps(PROJECT_DIR, "memory");
    expect(steps).toMatch(/restart/i);
    expect(steps).toMatch(/one instance|single instance/i);
  });

  it("always points at the environment file and the tunnel", () => {
    for (const choice of ["prisma", "memory"] as const) {
      const steps = nextSteps(PROJECT_DIR, choice);
      expect(steps).toContain("cp .env.example .env");
      expect(steps).toMatch(/tunnel/i);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter create-shopify-mcp test src/git.test.ts src/nextSteps.test.ts`
Expected: FAIL — neither module resolves.

- [ ] **Step 3: Write `src/git.ts`**

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface GitResult {
  initialized: boolean;
  committed: boolean;
}

export async function initGit(targetDir: string, env: NodeJS.ProcessEnv = process.env): Promise<GitResult> {
  try {
    await run("git", ["init", "-q"], { cwd: targetDir, env });
  } catch {
    return { initialized: false, committed: false };
  }

  try {
    await run("git", ["add", "-A"], { cwd: targetDir, env });
    await run("git", ["commit", "-q", "-m", "chore: scaffold shopify mcp server"], { cwd: targetDir, env });
  } catch {
    // No configured commit identity, or a hook refused. The repository is still usable.
    return { initialized: true, committed: false };
  }

  return { initialized: true, committed: true };
}
```

- [ ] **Step 4: Write `src/nextSteps.ts`**

```ts
import type { StorageChoice } from "./args";

export function nextSteps(projectDir: string, choice: StorageChoice): string {
  const lines = [`  cd ${projectDir} && pnpm install`, "  cp .env.example .env      # add your Shopify API key and secret"];

  if (choice === "prisma") {
    lines.push("  docker compose up -d", "  pnpm db:migrate && pnpm db:seed");
  }

  lines.push("  pnpm dev");
  lines.push("");
  lines.push("Then expose it — MCP clients and Shopify both need a public HTTPS URL:");
  lines.push("  cloudflared tunnel --url http://localhost:3000");
  lines.push("  set MCP_HOST to the tunnel URL, and add <MCP_HOST>/oauth/shopify-callback");
  lines.push("  to your Partner app's allowed redirection URLs.");

  if (choice === "memory") {
    lines.push("");
    lines.push("Note: in-memory storage loses every token on restart, and login breaks if you run");
    lines.push("more than one instance — authorization codes live in the same process. Switch to the");
    lines.push("Prisma variant before deploying.");
  }

  return lines.join("\n");
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter create-shopify-mcp test src/git.test.ts src/nextSteps.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/create-shopify-mcp/src/git.ts packages/create-shopify-mcp/src/git.test.ts packages/create-shopify-mcp/src/nextSteps.ts packages/create-shopify-mcp/src/nextSteps.test.ts
git commit -m "feat(cli): initialize git and print next steps"
```

---

## Task 7: Orchestration and the bin entry

**Files:**
- Create: `packages/create-shopify-mcp/src/run.ts`, `packages/create-shopify-mcp/src/index.ts`
- Test: `packages/create-shopify-mcp/src/run.test.ts`

**Interfaces:**
- Consumes: every module from Tasks 1–6
- Produces: `RunOptions`, `run(argv, options?): Promise<number>` (the process exit code)

`run` takes its prompt as an injectable function. Tests always pass `--storage`, so the interactive
path is never exercised automatically — that is a deliberate, stated gap: `@clack/prompts` drives a
TTY, and asserting on terminal escape sequences tests the library, not this code. The interactive path
is checked by hand once, in Task 9's manual step.

- [ ] **Step 1: Write the failing test**

`packages/create-shopify-mcp/src/run.test.ts`:

```ts
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./run";

const OAUTH_PACKAGE = "shopify-mcp-oauth";

let workspace: string;
let templateDir: string;

async function buildFakeTemplate(): Promise<void> {
  await mkdir(path.join(templateDir, "src"), { recursive: true });
  await mkdir(path.join(templateDir, "prisma"), { recursive: true });

  await writeFile(path.join(templateDir, "src", "storage.ts"), 'import { PrismaClient } from "@prisma/client";');
  await writeFile(path.join(templateDir, "src", "storage.memory.ts"), "export const storage = {};");
  await writeFile(path.join(templateDir, "prisma", "schema.prisma"), "model Session {}");
  await writeFile(path.join(templateDir, "docker-compose.yml"), "services: {}");
  await writeFile(path.join(templateDir, "gitignore"), "node_modules/\n");
  await writeFile(path.join(templateDir, ".env.example"), "MCP_HOST=https://your-tunnel.example.com\n");
  await writeFile(
    path.join(templateDir, "package.json"),
    JSON.stringify(
      {
        name: "basic-server",
        private: true,
        scripts: { dev: "tsx watch src/index.ts", postinstall: "prisma generate" },
        dependencies: { [OAUTH_PACKAGE]: "^0.1.0", "@prisma/client": "^6.19.3" },
        devDependencies: { prisma: "^6.19.3" },
      },
      null,
      2
    )
  );
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "create-shopify-mcp-run-"));
  templateDir = path.join(workspace, "template");
  await buildFakeTemplate();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(workspace, { recursive: true, force: true });
});

describe("run", () => {
  it("scaffolds a prisma project and reports success", async () => {
    const target = path.join(workspace, "my-mcp");
    const code = await run([target, "--storage", "prisma", "--no-git"], { templateDir });

    expect(code).toBe(0);
    expect(existsSync(path.join(target, "prisma", "schema.prisma"))).toBe(true);
    expect(JSON.parse(await readFile(path.join(target, "package.json"), "utf8")).name).toBe("my-mcp");
  });

  it("scaffolds a memory project without the prisma files", async () => {
    const target = path.join(workspace, "memory-mcp");
    await run([target, "--storage", "memory", "--no-git"], { templateDir });

    expect(existsSync(path.join(target, "prisma"))).toBe(false);
    expect(await readFile(path.join(target, "src", "storage.ts"), "utf8")).toContain('"./storage.memory"');
  });

  it("renames the undotted gitignore in the scaffolded project", async () => {
    const target = path.join(workspace, "ignored-mcp");
    await run([target, "--storage", "prisma", "--no-git"], { templateDir });

    expect(existsSync(path.join(target, ".gitignore"))).toBe(true);
  });

  it("asks for the storage choice only when --storage was omitted", async () => {
    const prompt = vi.fn().mockResolvedValue("memory" as const);

    await run([path.join(workspace, "asked"), "--no-git"], { templateDir, promptImpl: prompt });
    expect(prompt).toHaveBeenCalledTimes(1);

    await run([path.join(workspace, "not-asked"), "--storage", "prisma", "--no-git"], {
      templateDir,
      promptImpl: prompt,
    });
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("prints the help text and exits cleanly", async () => {
    const code = await run(["--help"], { templateDir });

    expect(code).toBe(0);
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain("npx create-shopify-mcp my-mcp");
  });

  it("fails with a usage message when no directory was given", async () => {
    await expect(run(["--storage", "memory"], { templateDir })).rejects.toThrow(/directory/i);
  });

  it("refuses to scaffold over an existing project", async () => {
    const target = path.join(workspace, "occupied");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "README.md"), "mine");

    await expect(run([target, "--storage", "memory", "--no-git"], { templateDir })).rejects.toThrow(/not empty/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter create-shopify-mcp test src/run.test.ts`
Expected: FAIL — cannot resolve `./run`.

- [ ] **Step 3: Write `src/run.ts`**

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isCancel, outro, select } from "@clack/prompts";
import { HELP_TEXT, parseArgs, type StorageChoice } from "./args";
import { copyTemplate } from "./copy";
import { initGit } from "./git";
import { nextSteps } from "./nextSteps";
import { rewritePackageJson, toPackageName } from "./packageJson";
import { prepareTarget } from "./target";
import { applyStorageChoice } from "./variant";

export interface RunOptions {
  /** Overrides the bundled template location. Tests point this at a freshly synced directory. */
  templateDir?: string;
  /** Replaces the interactive prompt. */
  promptImpl?: () => Promise<StorageChoice>;
}

function bundledTemplateDir(): string {
  // dist/index.js sits one level below the package root, next to templates/.
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "default");
}

async function readVersion(): Promise<string> {
  const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return (JSON.parse(await readFile(manifest, "utf8")) as { version: string }).version;
}

async function promptForStorage(): Promise<StorageChoice> {
  const answer = await select({
    message: "Storage",
    options: [
      { value: "prisma" as const, label: "Prisma + Postgres", hint: "survives a restart" },
      { value: "memory" as const, label: "In-memory", hint: "try it out; lost on restart" },
    ],
  });

  if (isCancel(answer)) {
    outro("Cancelled.");
    process.exit(0);
  }
  return answer;
}

export async function run(argv: string[], options: RunOptions = {}): Promise<number> {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(HELP_TEXT);
    return 0;
  }
  if (args.version) {
    console.log(await readVersion());
    return 0;
  }
  if (!args.targetDir) {
    throw new Error("Missing project directory. Try: npx create-shopify-mcp my-mcp");
  }

  const choice = args.storage ?? (await (options.promptImpl ?? promptForStorage)());
  const targetDir = await prepareTarget(args.targetDir);
  const projectName = toPackageName(targetDir);

  await copyTemplate(options.templateDir ?? bundledTemplateDir(), targetDir);
  await rewritePackageJson(targetDir, { name: projectName });
  await applyStorageChoice(targetDir, choice);

  const git = args.git ? await initGit(targetDir) : { initialized: false, committed: false };

  console.log(`\n✓ created ${projectName}\n`);
  console.log(nextSteps(path.relative(process.cwd(), targetDir) || projectName, choice));
  if (args.git && !git.committed) {
    console.log("\nGit: the repository was not committed — commit it yourself once you have set an identity.");
  }

  return 0;
}
```

- [ ] **Step 4: Write `src/index.ts`**

```ts
import { run } from "./run";

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((thrown: unknown) => {
    console.error(thrown instanceof Error ? thrown.message : String(thrown));
    process.exitCode = 1;
  });
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter create-shopify-mcp test src/run.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Typecheck and build**

Run: `pnpm --filter create-shopify-mcp typecheck && pnpm --filter create-shopify-mcp build`
Expected: no errors; `dist/index.js` exists and starts with `#!/usr/bin/env node`.

Verify the shebang:

```bash
head -1 packages/create-shopify-mcp/dist/index.js
```

- [ ] **Step 7: Commit**

```bash
git add packages/create-shopify-mcp/src/run.ts packages/create-shopify-mcp/src/run.test.ts packages/create-shopify-mcp/src/index.ts
git commit -m "feat(cli): wire the scaffolding pipeline behind one entry point"
```

---

## Task 8: Template sourcing at pack time

**Files:**
- Create: `packages/create-shopify-mcp/scripts/sync-template.mjs`
- Modify: root `package.json` (add the `sync:template` script)

**Interfaces:**
- Consumes: `examples/basic-server` (plan 2), `packages/shopify-mcp-oauth/package.json` (plan 1)
- Produces: `packages/create-shopify-mcp/templates/default`, with the workspace specifier resolved

The template is not a second copy of the example — it is generated from it, every time the package is
packed. That is what the spec means by "cannot drift": there is no second tree for someone to forget
to update.

- [ ] **Step 1: Write the failing check**

Run: `node packages/create-shopify-mcp/scripts/sync-template.mjs`
Expected: FAIL — the script does not exist.

- [ ] **Step 2: Write `packages/create-shopify-mcp/scripts/sync-template.mjs`**

```js
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
```

- [ ] **Step 3: Run it and check the output**

```bash
node packages/create-shopify-mcp/scripts/sync-template.mjs
grep '"shopify-mcp-oauth"' packages/create-shopify-mcp/templates/default/package.json
ls packages/create-shopify-mcp/templates/default
```

Expected: the dependency reads `"shopify-mcp-oauth": "^0.1.0"` — no `workspace:` — and the directory
contains `src/`, `prisma/`, `gitignore`, `.env.example`, `package.json`, and `README.md`, with no
`node_modules` or `dist`.

- [ ] **Step 4: Add the root script**

In the root `package.json`, add to `scripts`:

```json
"sync:template": "node packages/create-shopify-mcp/scripts/sync-template.mjs"
```

- [ ] **Step 5: Confirm the template stays out of git**

Run: `git status --short packages/create-shopify-mcp/templates`
Expected: no output — plan 1's `.gitignore` already covers `packages/create-shopify-mcp/templates/`.

- [ ] **Step 6: Commit**

```bash
git add packages/create-shopify-mcp/scripts/sync-template.mjs package.json
git commit -m "build(cli): generate the scaffold template from the example at pack time"
```

---

## Task 9: Scaffold integration test

**Files:**
- Test: `packages/create-shopify-mcp/src/scaffold.integration.test.ts`

**Interfaces:**
- Consumes: `run` from `./run`; the sync script from Task 8
- Produces: nothing — this task proves the real template scaffolds into a coherent project

Every earlier CLI test used a hand-built fake template. This one syncs the real example and scaffolds
it, which is the only way to catch a mismatch between the example's layout and the CLI's assumptions
about it — a renamed file in the example that the variant pruning still expects, for instance.

**Stated coverage gap:** this test asserts the shape and content of the scaffolded tree; it does not
run `pnpm install` and `tsc` inside it, because that pulls the full dependency tree from the network on
every CI run. A deeper check is available behind `SCAFFOLD_INSTALL_TEST=1`, and Step 5 runs it by hand
once before publishing.

- [ ] **Step 1: Write the failing test**

`packages/create-shopify-mcp/src/scaffold.integration.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { run } from "./run";

const OAUTH_PACKAGE = "shopify-mcp-oauth";
const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(packageRoot, "templates", "default");

let workspace: string;

beforeAll(async () => {
  execFileSync("node", ["scripts/sync-template.mjs"], { cwd: packageRoot, stdio: "pipe" });
  workspace = await mkdtemp(path.join(tmpdir(), "create-shopify-mcp-scaffold-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(async () => {
  vi.restoreAllMocks();
  await rm(workspace, { recursive: true, force: true });
});

async function scaffold(name: string, storage: "prisma" | "memory"): Promise<string> {
  const target = path.join(workspace, name);
  await run([target, "--storage", storage, "--no-git"], { templateDir });
  return target;
}

async function readManifest(target: string): Promise<Record<string, never>> {
  return JSON.parse(await readFile(path.join(target, "package.json"), "utf8"));
}

describe("scaffolding the real template", () => {
  it("produces a prisma project with every file the README references", async () => {
    const target = await scaffold("prisma-app", "prisma");

    for (const file of [
      "package.json",
      "tsconfig.json",
      ".env.example",
      ".gitignore",
      "README.md",
      "docker-compose.yml",
      "prisma/schema.prisma",
      "prisma/seed.ts",
      "prisma/migrations/0_init/migration.sql",
      "src/index.ts",
      "src/app.ts",
      "src/storage.ts",
      "src/mcp/transport.ts",
      "src/tools/whoami.ts",
    ]) {
      expect(existsSync(path.join(target, file)), `missing ${file}`).toBe(true);
    }
  });

  it("names the project after its directory and resolves the oauth dependency", async () => {
    const manifest = await readManifest(await scaffold("named-app", "prisma"));

    expect(manifest.name).toBe("named-app");
    expect(manifest.dependencies[OAUTH_PACKAGE]).toMatch(/^\^\d+\.\d+\.\d+$/);
  });

  it("leaves no workspace specifier anywhere in the scaffold", async () => {
    const target = await scaffold("clean-app", "prisma");
    const manifest = await readManifest(target);

    const specs = Object.values({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(specs.filter((spec: string) => spec.startsWith("workspace:"))).toEqual([]);
  });

  it("carries no secrets or build output from the working tree", async () => {
    const target = await scaffold("hygiene-app", "prisma");

    expect(existsSync(path.join(target, ".env"))).toBe(false);
    expect(existsSync(path.join(target, "node_modules"))).toBe(false);
    expect(existsSync(path.join(target, "dist"))).toBe(false);
  });

  it("produces a memory project with no Prisma surface left", async () => {
    const target = await scaffold("memory-app", "memory");
    const manifest = await readManifest(target);

    expect(existsSync(path.join(target, "prisma"))).toBe(false);
    expect(existsSync(path.join(target, "docker-compose.yml"))).toBe(false);
    expect(manifest.dependencies["@prisma/client"]).toBeUndefined();
    expect(manifest.scripts.postinstall).toBeUndefined();
    expect(await readFile(path.join(target, "src", "storage.ts"), "utf8")).toContain('"./storage.memory"');
  });

  it("keeps the memory project's imports resolvable — nothing points at a deleted file", async () => {
    const target = await scaffold("resolvable-app", "memory");
    const appTest = await readFile(path.join(target, "src", "app.test.ts"), "utf8");

    expect(appTest).toContain("./storage.memory");
    expect(existsSync(path.join(target, "src", "storage.memory.ts"))).toBe(true);
    expect(existsSync(path.join(target, "src", "storage.contract.test.ts"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter create-shopify-mcp test src/scaffold.integration.test.ts`
Expected: PASS, 6 tests. A failure here means the example moved and the CLI was not told — fix the CLI's
expectations, or the example, whichever is wrong.

- [ ] **Step 3: Run the whole CLI suite**

Run: `pnpm --filter create-shopify-mcp test`
Expected: PASS, 66 tests.

- [ ] **Step 4: Commit**

```bash
git add packages/create-shopify-mcp/src/scaffold.integration.test.ts
git commit -m "test(cli): scaffold the real template and assert both variants"
```

- [ ] **Step 5: Verify a scaffolded project by hand, once**

```bash
cd "$(mktemp -d)"
node ~/works/open_source_projects/shopify-mcp/packages/create-shopify-mcp/dist/index.js demo-mcp --storage memory
cd demo-mcp && pnpm install && pnpm typecheck && pnpm test
```

Expected: install succeeds, typecheck is clean, and the scaffolded project's own tests pass. Then run
the CLI once with no `--storage` flag to confirm the interactive prompt renders and both options work.
Record anything that fails as a fix before publishing — this is the only check of the interactive path
and of a real `pnpm install` against the published dependency ranges.

---

## Task 10: Repository README and the storage-adapter guide

**Files:**
- Create: `README.md`, `docs/storage-adapters.md`

**Interfaces:**
- Consumes: everything
- Produces: the documentation a stranger lands on

- [ ] **Step 1: Write `README.md`**

````markdown
# shopify-mcp

An MCP server boilerplate for Shopify apps, where the merchant logs in through Shopify instead of
copy-pasting a token.

Two packages:

| Package | What it is |
|---|---|
| [`shopify-mcp-oauth`](packages/shopify-mcp-oauth) | The OAuth layer: authorization server, resource server, and `requireAuth` |
| [`create-shopify-mcp`](packages/create-shopify-mcp) | `npx create-shopify-mcp my-mcp` — scaffolds a running server |

Plus [`examples/basic-server`](examples/basic-server), which is both the demo and the scaffolder's
template.

## Quickstart

```bash
npx create-shopify-mcp my-mcp
cd my-mcp && pnpm install
cp .env.example .env      # add your Shopify API key and secret
docker compose up -d
pnpm db:migrate && pnpm db:seed
pnpm dev
```

Then expose it with a tunnel, set `MCP_HOST`, add `<MCP_HOST>/oauth/shopify-callback` to your Partner
app's allowed redirection URLs, and connect:

```bash
claude mcp add --transport http my-mcp https://<your-tunnel>/mcp
```

## Why this exists

The hard part of building an MCP server for a Shopify app is not the tools — it is the auth. The MCP
specification requires the server to be **both** an OAuth resource server and an OAuth authorization
server, to support PKCE, to accept two different client-identification schemes, and to serve six
discovery documents that different clients look for in different places. Get one wrong and Claude
Code, VS Code, Cursor, and ChatGPT each fail in a different, silent way.

This ships that layer, and leaves the tools to you.

## Using the package directly

```ts
import express from "express";
import {
  createShopifyMcpOAuth,
  prismaStorage,
  shopifySessionStorage,
  redisCache,
} from "shopify-mcp-oauth";

const oauth = createShopifyMcpOAuth({
  host: "https://mcp.example.com",
  shopify: {
    apiKey: process.env.SHOPIFY_API_KEY!,
    apiSecret: process.env.SHOPIFY_API_SECRET!,
    scopes: "read_products,write_products",
  },
  stateSecret: process.env.OAUTH_STATE_SECRET!,
  storage: {
    ...prismaStorage(prisma),
    findShopByDomain: shopifySessionStorage(sessionStorage),
  },
  cache: redisCache(redis),
});

const app = express();
app.use(express.json());
app.use(oauth.router);
app.post("/mcp", oauth.requireAuth, myMcpHandler);

// Must be the LAST app.use(...) call, after every body-parser and route above (oauth.router
// included) -- a body-parser's SyntaxError on malformed JSON is thrown before Express ever
// reaches oauth.router, so an error handler mounted inside that router can't catch it. Only an
// error handler registered here, at this app's own outermost level, sees it.
app.use(oauth.errorHandler);
```

`requireAuth` sets `req.mcp = { shopId, shopDomain, tokenId }`.

## Configuration

| Field | Required | Default | Notes |
|---|---|---|---|
| `host` | yes | — | Public origin, HTTPS in production, no trailing slash. Every issued URL derives from this. |
| `shopify.apiKey` / `apiSecret` | yes | — | Your Shopify app's credentials — the same app the merchant installed. |
| `shopify.scopes` | yes | — | Comma-separated. Must match the installed app's scopes or Shopify re-prompts. |
| `stateSecret` | yes | — | HS256 signing key for the state JWT. At least 32 bytes. |
| `storage` | yes | — | An `OAuthStorage`. See [docs/storage-adapters.md](docs/storage-adapters.md). |
| `cache` | no | `memoryCache()` | Holds authorization codes and fetched client metadata documents. |
| `tokenTtl.access` | no | `3600` | Seconds. |
| `tokenTtl.refresh` | no | `2592000` | Seconds — 30 days. |
| `openaiAppsChallengeToken` | no | `null` | Only needed to list the server as a ChatGPT app. The route is omitted when null. |
| `registerRateLimit` | no | `{ limit: 20, windowMs: 3600000 }` | Dynamic client registration is unauthenticated by definition. |
| `revokeRateLimit` | no | `{ limit: 20, windowMs: 3600000 }` | `/revoke` is also unauthenticated by design (RFC 7009) — its own field, tuned independently of `registerRateLimit`. |
| `logger` | no | `console` | Anything with `info` / `warn` / `error`. |
| `fetchImpl` | no | the global `fetch` | Test seam: the package uses this for Shopify's own token exchange and for fetching client-metadata documents. |

Configuration is validated when you construct it. A missing or malformed value throws immediately,
naming the field — never at the first request.

## How login works

```
1. Client reads /.well-known/oauth-protected-resource (or is pointed there by a 401).
2. Client identifies itself — either a client-metadata URL, or by registering at /register.
3. Client opens a browser at /authorize with a PKCE challenge.
4. We redirect to Shopify's shop picker. The merchant chooses a store and approves.
5. Shopify calls /oauth/shopify-callback. We verify its HMAC and exchange the code —
   proof the merchant controls that shop. The Shopify token is then discarded.
6. We check the shop is one you know. If not: 403 shop_not_installed.
7. We issue a 60-second authorization code, the client redeems it at /token with its
   PKCE verifier, and gets an access token and a refresh token.
8. The client calls POST /mcp with `Authorization: Bearer <access_token>`.
```

The merchant's browser is the only participant that talks to Shopify during consent.

## The install gate

Step 6 is load-bearing. Completing Shopify's flow does **not** prove the app was already installed —
Shopify installs it on approval if it was not. Without the shop lookup, any merchant on Shopify could
mint a token for your server. `allowAnyShop()` removes that check; only use it if your app genuinely
keeps no per-shop record.

## Read this before deploying

**The default cache is single-process.** Authorization codes live in the cache, so with more than one
instance a login started on one instance fails on another, and the client reports an opaque
`invalid_grant`. Pass `cache: redisCache(redis)` before you scale past one process.

Other decisions worth knowing:

- Access and refresh tokens are stored as SHA-256 hashes — a database leak yields no usable tokens.
- PKCE S256 only. `plain` is rejected.
- Redirect URIs must match exactly, except that `localhost` and `127.0.0.1` ignore the port, which
  RFC 8252 requires for native clients binding an ephemeral port.
- Client-metadata documents are fetched with SSRF guards: HTTPS only, no private or loopback
  addresses, no redirects followed, a size cap, and a hard timeout.
- Refresh rotates: redeeming a refresh token revokes it and issues a new pair.
- `/revoke` always answers 200, per RFC 7009, so it cannot be used to probe which tokens exist.

## Development

```bash
pnpm install
pnpm build        # required before the example's tests — they import the built package
pnpm test
pnpm typecheck
pnpm lint
```

## License

MIT.
````

- [ ] **Step 2: Write `docs/storage-adapters.md`**

````markdown
# Storage adapters

`shopify-mcp-oauth` never assumes a database. Everything it persists goes through one interface, and
everything short-lived goes through another.

## The interfaces

```ts
interface OAuthStorage {
  findClient(clientId: string): Promise<OAuthClient | null>;
  createClient(client: NewOAuthClient): Promise<OAuthClient>;
  upsertClient(client: NewOAuthClient): Promise<OAuthClient>;

  createToken(token: NewToken): Promise<StoredToken>;
  findTokenByAccessHash(hash: string): Promise<StoredToken | null>;
  // Same match as findTokenByAccessHash, but ignoring expiry -- /revoke needs to be able to kill
  // a grant (including its still-live refresh token) even after the access token itself expired.
  findTokenByAccessHashIgnoringExpiry(hash: string): Promise<StoredToken | null>;
  findTokenByRefreshHash(hash: string): Promise<StoredToken | null>;
  revokeToken(id: string): Promise<boolean>;
  touchToken(id: string, lastUsedAt: Date): Promise<void>;

  findShopByDomain(domain: string): Promise<ShopRef | null>;
}

interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  getdel(key: string): Promise<string | null>;
}
```

Three details carry weight:

- **`findTokenByAccessHash` and `findTokenByRefreshHash` must filter expired and revoked rows.** The
  package trusts what you return.
- **`revokeToken` returns `false` when the row was already revoked.** Refresh rotation relies on that
  as its one-time-use guard: the request that flips `revokedAt` from null wins, and a concurrent
  second redemption of the same refresh token gets `false` and is rejected. Implement it as a
  conditional update (`WHERE id = ? AND revoked_at IS NULL`), not read-then-write.
- **`getdel` is required, not optional, and must be atomic.** It's what makes an authorization code
  single-use: of two concurrent callers redeeming the same key, exactly one may see the value. A
  `get` followed by a separate `del` is not a valid substitute — both callers can read the value
  before either deletes it, letting one code be redeemed twice. If your backend has no native
  atomic read-and-delete (a Lua script on Redis, a single transactional statement on SQL), implement
  it as a conditional delete that returns the pre-delete value only to the caller whose delete
  actually removed the row.

## Shipped adapters

| Adapter | Use |
|---|---|
| `prismaStorage(prisma)` | Clients and tokens on Prisma. Returns everything except `findShopByDomain`. |
| `prismaStorage(prisma, { shop })` | The same, plus a shop lookup mapped to your own table. |
| `memoryStorage()` | Tests and local exploration. |
| `shopifySessionStorage(sessionStorage)` | Shop lookup against any `@shopify/shopify-app-session-storage` adapter. |
| `allowAnyShop()` | Explicit opt-out of the install gate. |
| `memoryCache()` | Default cache. Single-process. |
| `redisCache(client)` | Production cache. |

## Where the shop comes from

`findShopByDomain` is the one method that touches your own data model, and no two apps model it the
same way. A table named `Shop` is not the common case: apps generated by the Shopify CLI have a
`Session` table, and that data may live in Redis, MongoDB, DynamoDB, or Cloudflare KV rather than SQL.

So the primary path binds to Shopify's own interface, not to a schema:

```ts
findShopByDomain: shopifySessionStorage(sessionStorage);
```

It calls `findSessionsByShop(domain)` — a required method on every official session-storage adapter —
and resolves the shop when an **offline** session with an access token exists. Swapping
`PrismaSessionStorage` for `RedisSessionStorage` changes one line in your app and nothing in ours.

Three supported wirings, in order of preference:

| Situation | Wiring |
|---|---|
| Your app uses `@shopify/shopify-app-*` | `shopifySessionStorage(sessionStorage)` |
| Your app has its own shop table | `prismaStorage(prisma, { shop: { model: "store", domainField: "myshopifyDomain", idField: "id" } })` |
| Your app keeps no per-shop record | `allowAnyShop()` |

This is enforced by types, not documentation: `prismaStorage(prisma)` returns
`Omit<OAuthStorage, "findShopByDomain">`, so a configuration missing the lookup does not compile.

`allowAnyShop()` removes the only gate that exists — read [the README's install-gate
section](../README.md#the-install-gate) before reaching for it.

## Writing your own

Any object matching `OAuthStorage` works: Drizzle, Sequelize, TypeORM, Mongo, raw SQL, Redis. A
sketch, with the parts that are easy to get wrong:

```ts
const storage: OAuthStorage = {
  async findTokenByAccessHash(hash) {
    // Filter here — the package does not re-check.
    return db.token.findFirst({
      where: { accessTokenHash: hash, revokedAt: null, accessTokenExpiresAt: { gt: new Date() } },
    });
  },

  async revokeToken(id) {
    // Conditional, so two concurrent refreshes cannot both succeed.
    const { count } = await db.token.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count > 0;
  },

  // ...the rest
};
```

## Proving it

The package ships the same suites it runs against its own adapters — one for `OAuthStorage`, one
for `CacheStore`:

```ts
import { runCacheContractTests, runStorageContractTests } from "shopify-mcp-oauth/testing";

runStorageContractTests(() => myStorage(), {
  seedShop: { id: "shop_1", domain: "demo.myshopify.com" },
});

// Exercises the atomic-getdel guarantee directly: of several callers racing the same key,
// exactly one may see the value. A get-then-del implementation fails this every time.
runCacheContractTests(() => myCache());
```

If you're writing a custom `CacheStore`, running this against it is the only way to know `getdel`
is actually atomic rather than merely present — the type system can't check that for you.

It covers expiry filtering, revocation semantics, hash uniqueness, null handling, and the one-time-use
guarantee on `revokeToken`. If it passes, the package will work against your storage.
````

- [ ] **Step 3: Check every internal link resolves**

```bash
grep -o '](\([^)]*\))' README.md docs/storage-adapters.md
```

Check each relative path exists. Fix any that do not.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/storage-adapters.md
git commit -m "docs: add the repository README and storage-adapter guide"
```

---

## Task 11: Continuous integration

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: root `package.json` (add the `lint` script)

**Interfaces:**
- Consumes: every package's `build`, `test`, `typecheck` script
- Produces: a green check on push and pull request

The order matters: **build before test**, because the example imports the package through its
`exports` map, which resolves to `dist/`. A test-first pipeline fails with "cannot find module
`shopify-mcp-oauth`" and sends whoever reads it looking in the wrong place.

Prettier is the lint gate. There is no ESLint in v0 — the rules that would matter here (unused
variables, floating promises) are already covered by `tsc --strict`, and a second tool with its own
configuration is not worth the dependency surface on a boilerplate people will fork.

- [ ] **Step 1: Add the root lint script**

In the root `package.json`, add to `scripts`:

```json
"lint": "prettier --check ."
```

Run: `pnpm lint`
Expected: either passes, or lists files to fix. Fix them with `pnpm format`, then re-run.

- [ ] **Step 2: Write `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node: [20, 22]

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      # The example imports the package through its exports map, which points at dist/.
      - run: pnpm build

      - run: pnpm lint

      - run: pnpm typecheck

      - run: pnpm test

      # Proves the scaffold template still generates cleanly from the example.
      - run: pnpm sync:template

      - name: Fail if the template carries a workspace specifier
        run: |
          if grep -q '"workspace:' packages/create-shopify-mcp/templates/default/package.json; then
            echo "templates/default still pins a workspace dependency"
            exit 1
          fi
```

- [ ] **Step 3: Run the whole pipeline locally**

```bash
pnpm install
pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm sync:template
```

Expected: all green. This is exactly what CI runs.

- [ ] **Step 4: Final scrub before the first push**

```bash
grep -rniE "storeseo|dataforseo|clickup|chatgpt-app-submission" --include="*.ts" --include="*.js" --include="*.mjs" --include="*.md" --include="*.json" --include="*.yml" --include="*.prisma" . | grep -v node_modules | grep -v "^./docs/superpowers/"
```

Expected: no output. The plans and specs under `docs/superpowers/` are the working documents and are
allowed to name their origin; nothing in the shipped tree may.

Then confirm no real credentials:

```bash
grep -rniE "shpat_|shpua_[a-z0-9]{20,}|sk-[a-zA-Z0-9]{20,}" --include="*.ts" --include="*.json" --include="*.md" . | grep -v node_modules
```

Expected: no output. The only `shpua_` string in the tree is the literal `shpua_exchanged_token` used
in tests, which is not a credential — verify each hit is one of those.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml package.json
git commit -m "ci: verify build, lint, types, tests, and the scaffold template"
```

---

## Done

The repository is complete against the spec: the package, the example, the scaffolder, the docs, and
CI. What remains is not code:

1. **Manual end-to-end pass.** A real Partner app, a real development store, a tunnel, and a login
   from Claude Code — then repeat from a second client (VS Code or Cursor) to shake out discovery-path
   assumptions. Spec §9 step 9.
2. **Publish.** `npm login`, then publish `shopify-mcp-oauth` first and `create-shopify-mcp` second —
   the CLI's template pins a concrete version of the package, so the package has to exist first.
   Release as `0.x`: the API is not frozen, and breaking changes should read as expected rather than
   as surprises.
3. **Push the repository** to GitHub as `shopify-mcp`, after the scrub in Task 11 Step 4 comes back
   clean.
