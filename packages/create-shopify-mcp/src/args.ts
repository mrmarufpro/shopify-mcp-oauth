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
