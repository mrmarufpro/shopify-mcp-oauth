# Examples

Scaffold any of these directly:

```bash
npx create-shopify-mcp --example basic-server my-mcp
```

| Example                        | What it shows                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| [`basic-server`](basic-server) | The smallest server that logs a merchant in through Shopify. Three files, in-memory storage. |

## Adding an example

`create-shopify-mcp` downloads a directory from this folder, so an example has to stand on its
own once it is unpacked somewhere else. Every example needs:

- **`package.json`** — also how the CLI checks the example exists, so it is mandatory.
- **`.gitignore`** — a real one, committed. The repository root's does not travel with a download.
- **`README.md`** — where the CLI sends people after scaffolding. Put the tunnel, environment
  and deployment specifics here; the CLI's own output stays generic.
- **`.env.example`** — if the example reads any environment at all.
- **`"shopify-mcp-oauth": "latest"`** for this repository's own packages. Never the `workspace:`
  protocol: it resolves only inside this repository, and the CLI refuses a manifest that uses it.
- **A name that is not `default`.** `--example default` is reserved: it means "use the template
  bundled inside the CLI", and is answered without contacting GitHub at all.

## Where downloads come from

`--example` fetches from the **newest GitHub release**, falling back to `main` when there is no
release yet. That pairing is deliberate: at a tagged commit the example and the published
`shopify-mcp-oauth` shipped together, so `latest` resolves to the version the example was written
against.

This puts a requirement on the release process — **cutting a GitHub release is what keeps
`--example` coherent.** Publishing `shopify-mcp-oauth` to npm without tagging a release leaves the
CLI on the `main` fallback, where a downloaded example can expect an API that is not published yet.
