export interface NextStepsOptions {
  hasEnvExample: boolean;
  hasDevScript: boolean;
  hasReadme: boolean;
}

export function nextSteps(projectDir: string, options: NextStepsOptions): string {
  const lines = [`  cd ${projectDir} && pnpm install`];

  if (options.hasEnvExample) {
    lines.push("  cp .env.example .env      # fill in the values it lists");
  }

  if (options.hasDevScript) {
    lines.push("  pnpm dev");
  }

  if (options.hasReadme) {
    lines.push("", `Then read ${projectDir}/README.md — it covers what this example needs`);
    lines.push("to actually run, and what to change before you deploy it.");
  }

  return lines.join("\n");
}
