# Trackers

A tracker is where `F issues create` files a project's issue batch, and where `F queue` / `F loop` read open issues and their dependencies. One file per tracker, loaded automatically: `github-issues.ts` ships. `index.mjs`, `index.ts`, files starting with `_` and declaration files are skipped.

## Add one

1. Copy `_template.ts` to `<id>.ts` (its types come from `index.ts`). For one kept outside this repo, copy it to `<id>.mjs`
   and delete the type annotations and `import type` lines. The file name, without its extension, must equal `export const id`.
2. Implement the three functions. Each gets `ctx = {gh, git}`:

| Function | Returns | Must |
|---|---|---|
| `createIssues(ctx, {repo, items, existing, onCreated})` | `[{key, id, url, created}]` in item order | Items arrive in dependency order, the epic last. Skip keys in `existing` and keys already in the tracker (store the key somewhere stable; GitHub uses a hidden `<!-- factory-key: k -->` marker). Call `onCreated` right after each create so a crash mid-batch loses nothing. Label every non-epic issue `factory:ready`. ids are strings. |
| `listOpen(ctx, {repo})` | `[{id, title, labels, key, …}]` | Open issues only, with label names. |
| `dependencies(item)` | `[id]` | The ids an item from `listOpen` waits on. |

3. Use it: `F new "<idea>" --tracker <id>`. No core change.

## Test

`node factory.mjs test` runs the shared `contract()` in `index.ts` against every tracker in this folder (with the fake `gh`), and against a fake tracker written as one file in a temp dir. The contract creates a, b (depends on a) and an epic, re-runs with `existing` and expects zero creates, then checks `listOpen` labels and `dependencies`.

Point `FACTORY_TRACKERS` at another folder to load trackers from there instead.

## `.mjs` or `.ts`

A provider is `<id>.mjs`, or `<id>.ts` where Node strips types: not under `node_modules`, not in a `"type": "commonjs"`
package, and on a Node with `process.features.typescript` on (a `.ts` file is refused otherwise, naming it and saying to
use `.mjs`). `.mjs` loads everywhere, so it is the safe format for a provider kept outside this repo. The id is the file
name without its extension, so `<id>.ts` next to `<id>.mjs` (a compiled twin) is refused: remove one. `index.*`, `_*` and
declaration files (`*.d.ts`, `*.d.mts`) are never loaded. A file that fails to import is reported with its name.
Node only strips types, it compiles nothing: a `.ts` file must use erasable syntax only (no `enum`, `namespace`,
parameter properties or other TypeScript that emits code; type-only imports as `import type`). The desktop build
would compile those, but F under Node fails on them, naming the file.

## Not yet on the adapter

Per-issue intake (`F intake`, stage comments and labels) still calls `gh` directly. Moving it onto this adapter is a follow-up; until then a non-GitHub tracker covers `F issues create`, `F queue` and `F loop` only.
