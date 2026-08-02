import type { StorageChoice } from "./args";

export function nextSteps(projectDir: string, choice: StorageChoice): string {
  const lines = [
    `  cd ${projectDir} && pnpm install`,
    "  cp .env.example .env      # add your Shopify API key and secret",
  ];

  if (choice === "prisma") {
    lines.push("  docker compose up -d", "  pnpm db:migrate && pnpm db:seed");
  }

  lines.push("  pnpm dev");
  lines.push("");
  lines.push("Then expose it — MCP clients and Shopify both need a public HTTPS URL:");
  lines.push("  cloudflared tunnel --url http://localhost:3000");
  lines.push("  set MCP_HOST to the tunnel URL, and add <MCP_HOST>/oauth/shopify-callback");
  lines.push("  to your Partner app's allowed redirection URLs.");

  if (choice === "memory") {
    lines.push("");
    lines.push("Note: in-memory storage loses every token on restart, and login breaks if you run");
    lines.push("more than one instance — authorization codes live in the same process. Switch to the");
    lines.push("Prisma variant before deploying.");
  }

  return lines.join("\n");
}
