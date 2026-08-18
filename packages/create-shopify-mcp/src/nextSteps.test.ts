import { describe, expect, it } from "vitest";
import { nextSteps } from "./nextSteps";

const PROJECT_DIR = "my-mcp";
const COMPLETE_EXAMPLE = { hasEnvExample: true, hasDevScript: true, hasReadme: true };
const WITHOUT_ENV = { hasEnvExample: false, hasDevScript: true, hasReadme: true };
const BARE_EXAMPLE = { hasEnvExample: false, hasDevScript: false, hasReadme: false };

describe("nextSteps", () => {
  it("starts by entering the project and installing", () => {
    const steps = nextSteps(PROJECT_DIR, COMPLETE_EXAMPLE);

    expect(steps).toContain(`cd ${PROJECT_DIR}`);
    expect(steps).toContain("pnpm install");
  });

  it("offers the environment file only when the example ships one", () => {
    expect(nextSteps(PROJECT_DIR, COMPLETE_EXAMPLE)).toContain("cp .env.example .env");
    expect(nextSteps(PROJECT_DIR, WITHOUT_ENV)).not.toContain(".env.example");
  });

  it("sends the reader to the example's own README for anything specific", () => {
    expect(nextSteps(PROJECT_DIR, COMPLETE_EXAMPLE)).toContain(`${PROJECT_DIR}/README.md`);
  });

  it("hardcodes nothing about any one example", () => {
    const steps = nextSteps(PROJECT_DIR, COMPLETE_EXAMPLE);

    expect(steps).not.toMatch(/cloudflared/i);
    expect(steps).not.toMatch(/in-memory/i);
    expect(steps).not.toMatch(/partner app/i);
  });

  it("ends on the command that actually starts the server", () => {
    expect(nextSteps(PROJECT_DIR, COMPLETE_EXAMPLE)).toContain("pnpm dev");
  });

  it("omits pnpm dev when the example has no dev script", () => {
    expect(nextSteps(PROJECT_DIR, BARE_EXAMPLE)).not.toContain("pnpm dev");
  });

  it("omits the README sentence when the example ships no README", () => {
    expect(nextSteps(PROJECT_DIR, BARE_EXAMPLE)).not.toContain("README.md");
  });

  it("still produces the cd and install line for a bare example with nothing else", () => {
    expect(nextSteps(PROJECT_DIR, BARE_EXAMPLE)).toBe(`  cd ${PROJECT_DIR} && pnpm install`);
  });
});
