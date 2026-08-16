# create-shopify-mcp

Scaffold an MCP server for a Shopify app, with OAuth login already wired.

```bash
npm create shopify-mcp@latest my-mcp
```

The generated server authenticates merchants through Shopify — no copy-pasted tokens — using
[`shopify-mcp-oauth`](https://www.npmjs.com/package/shopify-mcp-oauth).

> **Pre-1.0.** While the version is `0.x`, a **minor** bump may contain breaking changes and a
> **patch** bump will not.

## Usage

```
Usage: npx create-shopify-mcp my-mcp [options]

Options:
  --storage <prisma|memory>  Storage variant. Prompts when omitted.
                             prisma  Postgres via Prisma, survives a restart
                             memory  in-process, single instance, lost on restart
  --no-git                   Skip git init
  -h, --help                 Show this message
  -v, --version              Show the version
```

## What you get

A runnable Express + MCP server with the OAuth layer mounted, a demo tool or two, and tests that
pass on a fresh clone:

```
my-mcp/
  src/
    index.ts           entry point
    app.ts             Express app with OAuth mounted
    config.ts          env parsing
    storage.ts         the storage wiring for your chosen variant
    mcp/               transport, per-request context, audit logging
    tools/             echo and whoami, as examples to replace
  prisma/              schema, migration, and seed   (prisma variant only)
  docker-compose.yml   local Postgres                (prisma variant only)
  .env.example
```

The `memory` variant drops `prisma/`, `docker-compose.yml`, the Prisma dependencies and scripts, and
`DATABASE_URL` — everything lives in-process and is lost on restart. Good for a first look; not for
anything with more than one instance.

## Getting it running

```bash
npm create shopify-mcp@latest my-mcp
cd my-mcp && pnpm install
cp .env.example .env      # add your Shopify API key and secret
docker compose up -d      # prisma variant only
pnpm db:migrate && pnpm db:seed   # prisma variant only
pnpm dev
```

Then expose it with a tunnel, set `MCP_HOST`, add `<MCP_HOST>/oauth/shopify-callback` to your
Partner app's allowed redirection URLs, and connect:

```bash
claude mcp add --transport http my-mcp https://<your-tunnel>/mcp
```

## Requirements

- Node.js 20 or newer
- A Shopify Partner app, for the API key and secret
- Postgres, for the `prisma` variant only — `docker-compose.yml` provides one

## Already have an MCP server?

Do not scaffold. Add the OAuth layer to what you have:
[integration guide](https://github.com/mrmarufpro/shopify-mcp-oauth/blob/main/docs/integrating-an-existing-server.md).

## License

MIT
