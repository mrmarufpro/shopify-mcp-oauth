export interface CliArgs {
  targetDir: string | null;
  git: boolean;
  help: boolean;
  version: boolean;
}

export const HELP_TEXT = `
Usage: npx create-shopify-mcp my-mcp [options]

Options:
  --no-git       Skip git init
  -h, --help     Show this message
  -v, --version  Show the version
`.trim();

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { targetDir: null, git: true, help: false, version: false };

  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") {
      args.help = true;
    } else if (argument === "--version" || argument === "-v") {
      args.version = true;
    } else if (argument === "--no-git") {
      args.git = false;
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
