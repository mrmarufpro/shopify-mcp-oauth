# Changesets

A changeset is a note describing a change and how it should bump the version. Add one to any pull
request that changes `shopify-mcp-oauth` or `create-shopify-mcp`:

```bash
pnpm changeset
```

Pick the packages you changed, pick `patch` or `minor`, and write the line that should appear in the
CHANGELOG. Commit the generated `.changeset/*.md` file with your work.

**Both packages are pre-1.0.** Under `0.x`, a **minor** bump may contain breaking changes and a
**patch** bump may not. Choose `minor` for anything a user would have to react to.

A pull request with no changeset publishes nothing, which is the right answer for a docs or CI
change.

**`pnpm changeset` needs Node 22 or newer.** `@changesets/cli` declares `engines.node: "^22.11 ||
^24 || >=26"`, which is stricter than the `>=20` this repo otherwise supports and tests against. On
Node 20 the command fails outright, and nothing in CI catches this ahead of time — CI never invokes
changesets. If `pnpm changeset` won't run, switch to Node 22+ rather than debugging further.

**A library minor bump needs a CLI patch changeset in the same pull request.** `create-shopify-mcp`'s
`prepack` pins the scaffolded template at the `shopify-mcp-oauth` version being released, and that pin
freezes inside the published CLI tarball. If `shopify-mcp-oauth` goes `0.1.0` → `0.2.0` with no
changeset for `create-shopify-mcp`, `create-shopify-mcp@latest` stays on the registry at `0.1.0` and
keeps scaffolding projects pinned to the superseded `^0.1.0` — indefinitely, while the docs it links to
describe `0.2.0`. Add a `patch` changeset for `create-shopify-mcp` in the same pull request as any
`shopify-mcp-oauth` minor bump, even if nothing in the CLI itself changed.
