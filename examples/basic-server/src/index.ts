import { z } from "zod";
import { createApp } from "./app";

const environment = z
  .object({
    MCP_HOST: z.string().url(),
    SHOPIFY_API_KEY: z.string().min(1),
    SHOPIFY_API_SECRET: z.string().min(1),
    SHOPIFY_SCOPES: z.string().min(1).default("read_products"),
    OAUTH_STATE_SECRET: z.string().min(32),
    PORT: z.coerce.number().int().positive().default(3000),
  })
  .safeParse(process.env);

if (!environment.success) {
  const fields = [...new Set(environment.error.issues.map((issue) => issue.path.join(".")))].join(", ");
  console.error(`Invalid environment — check these variables in .env: ${fields}`);
  process.exit(1);
}

const env = environment.data;

const app = createApp({
  // Must be the public HTTPS origin, not localhost: it is the redirect target Shopify sends the
  // merchant back to, and the `resource` MCP clients check the issued token against.
  host: env.MCP_HOST,
  shopify: { apiKey: env.SHOPIFY_API_KEY, apiSecret: env.SHOPIFY_API_SECRET, scopes: env.SHOPIFY_SCOPES },
  stateSecret: env.OAUTH_STATE_SECRET,
});

app.listen(env.PORT, () => {
  console.log(`Listening on http://localhost:${env.PORT}, published at ${env.MCP_HOST}`);
  console.log(`Connect with: claude mcp add --transport http my-mcp ${env.MCP_HOST}/mcp`);
});
