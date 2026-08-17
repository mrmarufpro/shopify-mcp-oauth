import { describe, expect, it } from "vitest";
import { nextSteps } from "./nextSteps";

const PROJECT_DIR = "my-mcp";
const WITH_ENV = { hasEnvExample: true };
const WITHOUT_ENV = { hasEnvExample: false };

describe("nextSteps", () => {
  it("starts by entering the project and installing", () => {
    const steps = nextSteps(PROJECT_DIR, WITH_ENV);

    expect(steps).toContain(`cd ${PROJECT_DIR}`);
    expect(steps).toContain("pnpm install");
  });

  it("offers the environment file only when the example ships one", () => {
    expect(nextSteps(PROJECT_DIR, WITH_ENV)).toContain("cp .env.example .env");
    expect(nextSteps(PROJECT_DIR, WITHOUT_ENV)).not.toContain(".env.example");
  });

  it("sends the reader to the example's own README for anything specific", () => {
    expect(nextSteps(PROJECT_DIR, WITH_ENV)).toContain(`${PROJECT_DIR}/README.md`);
  });

  it("hardcodes nothing about any one example", () => {
    const steps = nextSteps(PROJECT_DIR, WITH_ENV);

    expect(steps).not.toMatch(/cloudflared/i);
    expect(steps).not.toMatch(/in-memory/i);
    expect(steps).not.toMatch(/partner app/i);
  });

  it("ends on the command that actually starts the server", () => {
    expect(nextSteps(PROJECT_DIR, WITH_ENV)).toContain("pnpm dev");
  });
});
