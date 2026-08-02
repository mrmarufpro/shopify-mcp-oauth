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
    await run("git", ["commit", "-q", "-m", "chore: scaffold shopify mcp server"], {
      cwd: targetDir,
      env,
    });
  } catch {
    // No configured commit identity, or a hook refused. The repository is still usable.
    return { initialized: true, committed: false };
  }

  return { initialized: true, committed: true };
}
