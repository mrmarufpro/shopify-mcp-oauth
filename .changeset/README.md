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
