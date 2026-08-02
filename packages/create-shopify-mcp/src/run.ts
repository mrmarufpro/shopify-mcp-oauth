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
