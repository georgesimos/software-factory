# Repo hosts

A host is where `F new` creates a new project's repo and pushes its first commit. One file per host, loaded automatically: `github.ts` ships. `index.mjs`, `index.ts`, files starting with `_` and declaration files are skipped.

## Add one

1. Copy `_template.ts` to `<id>.ts` (its types come from `index.ts`). For one kept outside this repo, copy it to `<id>.mjs`
   and delete the type annotations and `import type` lines. The file name, without its extension, must equal `export const id`.
2. Implement the three functions. Each gets `ctx = {gh, git}` (both respect the `FACTORY_GH` / `FACTORY_GIT` stubs):

| Function | Returns | Must |
|---|---|---|
| `authStatus(ctx)` | `{ok:true, login}` or `{ok:false, detail}` | Only check. Never log in or create an account. `F new` calls it first and records nothing when it fails. |
| `createRepo(ctx, {repo, visibility, description})` | `{created, url}` | Create the repo, or change nothing and return `created:false` if it exists. `F new` refuses a repo it did not create. |
| `pushInitial(ctx, {repo, path, branch})` | `{pushed:true}` | Add the remote if missing and push `HEAD` to `branch` (default `main`). Never `--force`. Re-running is a no-op. |

3. Use it: `F new "<idea>" --host <id>`. No core change.

## Test

`node factory.mjs test` runs the shared `contract()` in `index.ts` against every host in this folder, using the stateful fake `gh` in `test/gh-project-stub.mjs`, and against a fake host written as one file in a temp dir. A host that shells out to a CLI other than `gh` needs its own stub before it can pass; never run the contract against a real account.

Point `FACTORY_HOSTS` at another folder to load hosts from there instead.

## `.mjs` or `.ts`

A provider is `<id>.mjs`, or `<id>.ts` where Node strips types: not under `node_modules`, not in a `"type": "commonjs"`
package, and on a Node with `process.features.typescript` on (a `.ts` file is refused otherwise, naming it and saying to
use `.mjs`). `.mjs` loads everywhere, so it is the safe format for a provider kept outside this repo. The id is the file
name without its extension, so `<id>.ts` next to `<id>.mjs` (a compiled twin) is refused: remove one. `index.*`, `_*` and
declaration files (`*.d.ts`, `*.d.mts`) are never loaded. A file that fails to import is reported with its name.
Node only strips types, it compiles nothing: a `.ts` file must use erasable syntax only (no `enum`, `namespace`,
parameter properties or other TypeScript that emits code; type-only imports as `import type`). The desktop build
would compile those, but F under Node fails on them, naming the file.

## GitHub notes

`pushInitial` pushes over the URL `gh repo create` returns. For an https URL, git needs `gh auth setup-git` (or another credential helper) once; F does not configure it for you.
