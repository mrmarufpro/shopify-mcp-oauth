export function nextSteps(projectDir: string): string {
  return [
    `  cd ${projectDir} && pnpm install`,
    "  cp .env.example .env      # add your Shopify API key and secret",
    "  pnpm dev",
    "",
    "Then expose it — MCP clients and Shopify both need a public HTTPS URL:",
    "  cloudflared tunnel --url http://localhost:3000",
    "  set MCP_HOST to the tunnel URL, and add <MCP_HOST>/oauth/shopify-callback",
    "  to your Partner app's allowed redirection URLs.",
    "",
    "Storage is in-memory: tokens are lost on restart, and login breaks once you run",
    "more than one instance — authorization codes live in a single process. Swap in a",
    "database-backed OAuthStorage and a shared cache before deploying. See the README.",
  ].join("\n");
}
