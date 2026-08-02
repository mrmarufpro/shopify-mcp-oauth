import { describe, expect, it } from "vitest";
import { nextSteps } from "./nextSteps";

const PROJECT_DIR = "my-mcp";

describe("nextSteps", () => {
  it("starts by entering the project and installing", () => {
    const steps = nextSteps(PROJECT_DIR, "prisma");
    expect(steps).toContain(`cd ${PROJECT_DIR}`);
    expect(steps).toContain("pnpm install");
  });

  it("tells the Prisma user to start the database, migrate, and seed", () => {
    const steps = nextSteps(PROJECT_DIR, "prisma");
    expect(steps).toContain("docker compose up -d");
    expect(steps).toContain("pnpm db:migrate");
    expect(steps).toContain("pnpm db:seed");
  });

  it("omits the database steps for the memory variant", () => {
    const steps = nextSteps(PROJECT_DIR, "memory");
    expect(steps).not.toContain("docker compose");
    expect(steps).not.toContain("db:migrate");
  });

  it("warns the memory user that tokens vanish and a second instance breaks login", () => {
    const steps = nextSteps(PROJECT_DIR, "memory");
    expect(steps).toMatch(/restart/i);
    expect(steps).toMatch(/one instance|single instance/i);
  });

  it("always points at the environment file and the tunnel", () => {
    for (const choice of ["prisma", "memory"] as const) {
      const steps = nextSteps(PROJECT_DIR, choice);
      expect(steps).toContain("cp .env.example .env");
      expect(steps).toMatch(/tunnel/i);
    }
  });
});
