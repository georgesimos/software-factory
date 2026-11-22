# Add a provider in 4 steps

A provider (Vercel, Neon, Expo, App Store Connect, Netlify, ...) is **one file plus its fixture**. The registry loads every
`connectors/*.mjs` by itself, and the events, the `deploy.preview` rule and the dashboard only read the normalized shape, so
nothing else in the repo changes.

1. **Copy the template.** `cp connectors/_template.mjs connectors/<id>.mjs` and set `id` (lowercase, unique) and `kind`
   (`web-deploy`, `mobile-build`, `store` or `database`). Files starting with `_` are never loaded.
2. **Map the provider to the contract** (`contract.mjs`):
   - `detect(project, ctx)`: does `project.repo` / `project.path` use it? Prefer a config file over an API call.
   - `auth(ctx)`: `{ok, how}` from the provider's own CLI login (`vercel whoami`, `eas whoami`, `neonctl me`). Never read or store a token.
   - `status(project, sha, ctx)`: rows `{env, state, url?, sha?, at?, detail?, creator?}`. `state` must be one of the kind's
     states in `KINDS`. Name the PR environment `preview` and the live one `production`; the rule looks for those.
   - Call the provider only through `ctx.exec(cmd, args)`. Tests swap it, and `FACTORY_<CMD>` swaps the binary.
   - `actions`: tag each one `read`, `write` or `public`. Phase 0 accepts only `read`.
3. **Add its fixture,** `test/fixtures/<id>.json`, with real responses from the provider's CLI:
   ```json
   {
     "project": { "repo": "acme/app" },
     "detect": true,
     "exec": { "<cmd> <args joined by spaces>": "<stdout, or any JSON value>" },
     "cases": [{ "sha": "<40 hex>", "expect": [<normalized rows>] }, { "expect": [<latest per env>] }]
   }
   ```
   A call the fixture doesn't list fails the test, so it never reaches the network.
4. **Check it.** `pnpm --filter @software-factory/ship test` runs the shared contract against every connector, the new one included.
   Then try it for real, read only: `node packages/ship/ship.mjs detect owner/repo` and `node packages/ship/ship.mjs status owner/repo [sha]`.

Once it passes, `F sync` records the provider's states on in-progress runs, `F decide` counts its ready previews under
`deploy.preview`, and the dashboard shows them.
