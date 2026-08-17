import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HELP_TEXT, parseArgs } from "./args";
import { copyTemplate } from "./copy";
import { initGit } from "./git";
import { nextSteps } from "./nextSteps";
import { rewritePackageJson, toPackageName } from "./packageJson";
import { prepareTarget } from "./target";

export interface RunOptions {
  /** Overrides the bundled template location. Tests point this at a freshly synced directory. */
  templateDir?: string;
}

function bundledTemplateDir(): string {
  // dist/index.js sits one level below the package root, next to templates/.
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "default");
}

async function readVersion(): Promise<string> {
  const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return (JSON.parse(await readFile(manifest, "utf8")) as { version: string }).version;
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

  const targetDir = await prepareTarget(args.targetDir);
  const projectName = toPackageName(targetDir);

  await copyTemplate(options.templateDir ?? bundledTemplateDir(), targetDir);
  await rewritePackageJson(targetDir, { name: projectName });

  const git = args.git ? await initGit(targetDir) : { initialized: false, committed: false };

  console.log(`\n✓ created ${projectName}\n`);
  console.log(
    nextSteps(path.relative(process.cwd(), targetDir) || projectName, {
      hasEnvExample: existsSync(path.join(targetDir, ".env.example")),
    })
  );
  if (args.git && !git.committed) {
    console.log("\nGit: the repository was not committed — commit it yourself once you have set an identity.");
  }

  return 0;
}
