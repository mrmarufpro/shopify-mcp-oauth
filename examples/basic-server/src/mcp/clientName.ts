export const UNKNOWN_CLIENT_MAX_LENGTH = 64;

const CLIENT_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["claude-code/", "claude-code"],
  ["Visual Studio Code/", "vscode"],
  ["VSCode/", "vscode"],
  ["cursor/", "cursor"],
  ["chatgpt/", "chatgpt"],
];

export function classifyClient(userAgent: string | string[] | undefined): string {
  const agent = Array.isArray(userAgent) ? userAgent[0] : userAgent;
  if (!agent) return "unknown";

  for (const [prefix, name] of CLIENT_PREFIXES) {
    if (agent.startsWith(prefix)) return name;
  }
  return agent.slice(0, UNKNOWN_CLIENT_MAX_LENGTH);
}
