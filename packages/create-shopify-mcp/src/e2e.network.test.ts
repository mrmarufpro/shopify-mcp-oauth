import { describe, expect, it } from "vitest";
import { exampleExists } from "./download";
import { parseExampleTarget, resolveRef } from "./example";

const ENABLED = process.env.CREATE_SHOPIFY_MCP_E2E === "1";
const EXAMPLE_NAME = "basic-server";

describe.skipIf(!ENABLED)("against the real GitHub API", () => {
  it("resolves a ref and finds the example there", async () => {
    const deps = { fetch: globalThis.fetch };

    const source = await resolveRef(parseExampleTarget(EXAMPLE_NAME), deps);

    expect(source.ref).not.toBe("");
    await expect(exampleExists(source, deps)).resolves.toBe(true);
  });

  it("reports a name that is not there", async () => {
    const deps = { fetch: globalThis.fetch };
    const source = await resolveRef(parseExampleTarget("no-such-example"), deps);

    await expect(exampleExists(source, deps)).resolves.toBe(false);
  });
});
