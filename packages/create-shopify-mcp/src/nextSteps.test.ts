import { describe, expect, it } from "vitest";
import { nextSteps } from "./nextSteps";

const PROJECT_DIR = "my-mcp";

describe("nextSteps", () => {
  it("starts by entering the project and installing", () => {
    const steps = nextSteps(PROJECT_DIR);
    expect(steps).toContain(`cd ${PROJECT_DIR}`);
    expect(steps).toContain("pnpm install");
  });

  it("names no database step — the template is in-memory only", () => {
    const steps = nextSteps(PROJECT_DIR);
    expect(steps).not.toContain("docker compose");
    expect(steps).not.toContain("db:migrate");
    expect(steps).not.toContain("db:seed");
  });

  it("warns that tokens vanish on restart and a second instance breaks login", () => {
    const steps = nextSteps(PROJECT_DIR);
    expect(steps).toMatch(/restart/i);
    expect(steps).toMatch(/more than one instance/i);
  });

  it("points at the environment file and the tunnel", () => {
    const steps = nextSteps(PROJECT_DIR);
    expect(steps).toContain("cp .env.example .env");
    expect(steps).toMatch(/tunnel/i);
  });

  it("ends on the command that actually starts the server", () => {
    expect(nextSteps(PROJECT_DIR)).toContain("pnpm dev");
  });
});
