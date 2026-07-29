import { z } from "zod";

const environmentSchema = z.object({
  MCP_HOST: z.string().url(),
  SHOPIFY_API_KEY: z.string().min(1),
  SHOPIFY_API_SECRET: z.string().min(1),
  SHOPIFY_SCOPES: z.string().min(1),
  OAUTH_STATE_SECRET: z.string().min(32),
  PORT: z.coerce.number().int().positive().default(3000),
  DEMO_SHOP_DOMAIN: z.string().min(1).default("demo.myshopify.com"),
});

export interface ExampleConfig {
  host: string;
  port: number;
  demoShopDomain: string;
  shopify: { apiKey: string; apiSecret: string; scopes: string };
  stateSecret: string;
}

export function loadConfig(environment: Record<string, string | undefined> = process.env): ExampleConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))].join(", ");
    throw new Error(`Invalid environment — check these variables in .env: ${fields}`);
  }

  const values = parsed.data;
  return {
    host: values.MCP_HOST.replace(/\/+$/, ""),
    port: values.PORT,
    demoShopDomain: values.DEMO_SHOP_DOMAIN,
    shopify: {
      apiKey: values.SHOPIFY_API_KEY,
      apiSecret: values.SHOPIFY_API_SECRET,
      scopes: values.SHOPIFY_SCOPES,
    },
    stateSecret: values.OAUTH_STATE_SECRET,
  };
}
