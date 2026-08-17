export interface CliArgs {
  targetDir: string | null;
  example: string | null;
  examplePath: string | null;
  git: boolean;
  help: boolean;
  version: boolean;
}

export const HELP_TEXT = `
Usage: npx create-shopify-mcp my-mcp [options]

Options:
  -e, --example <name|url>  Scaffold from an example, by name or GitHub URL
      --example-path <path>  Path to the example inside the repository
      --no-git               Skip git init
  -h, --help                 Show this message
  -v, --version              Show the version

Examples:
  npx create-shopify-mcp my-mcp
  npx create-shopify-mcp --example basic-server my-mcp
`.trim();

type ValueFlag = "example" | "examplePath";

const VALUE_FLAGS = new Map<string, ValueFlag>([
  ["--example", "example"],
  ["-e", "example"],
  ["--example-path", "examplePath"],
]);

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    targetDir: null,
    example: null,
    examplePath: null,
    git: true,
    help: false,
    version: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const inlineValue = equals === -1 ? null : argument.slice(equals + 1);
    const field = VALUE_FLAGS.get(name);

    if (field) {
      const value = inlineValue ?? argv[index + 1] ?? null;
      if (value === null || value.length === 0 || (inlineValue === null && value.startsWith("-"))) {
        throw new Error(`${name} needs a value. Run with --help.`);
      }
      if (inlineValue === null) index += 1;
      args[field] = value;
    } else if (name === "--help" || name === "-h") {
      args.help = true;
    } else if (name === "--version" || name === "-v") {
      args.version = true;
    } else if (name === "--no-git") {
      args.git = false;
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option ${argument}. Run with --help.`);
    } else if (args.targetDir === null) {
      args.targetDir = argument;
    } else {
      throw new Error(`Unexpected argument ${argument}. Only one project directory is supported.`);
    }
  }

  if (args.examplePath !== null && args.example === null) {
    throw new Error("--example-path only means something together with --example.");
  }

  return args;
}
