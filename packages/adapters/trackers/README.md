# Trackers

A tracker is where `F issues create` files a project's issue batch, and where `F queue` / `F loop` read open issues and their dependencies. One file per tracker, loaded automatically: `github-issues.ts` and `local.ts` ship. `index.mjs`, `index.ts`, files starting with `_` and declaration files are skipped.

## Add one

1. Copy `_template.ts` to `<id>.ts` (its types come from `index.ts`). For one kept outside this repo, copy it to `<id>.mjs`
   and delete the type annotations and `import type` lines. The file name, without its extension, must equal `export const id`.
2. Implement the three functions. Each gets `ctx = {gh, git}`, and its options carry `path`, the project's clone, when core knows it:

| Function | Returns | Must |
|---|---|---|
| `createIssues(ctx, {repo, items, existing, onCreated, ready})` | `[{key, id, url, created}]` in item order | Items arrive in dependency order, the epic last. Skip keys in `existing` and keys already in the tracker (store the key somewhere stable; GitHub uses a hidden `<!-- factory-key: k -->` marker). Anyone can write a marker, so GitHub adopts only an issue its own account (`gh api user`) wrote, and a `split-N-M` key only from a body that starts `Part of #N`. Call `onCreated` right after each create so a crash mid-batch loses nothing. Label every non-epic issue `factory:ready`. ids are strings. With `ready: false` (`F split` for an untrusted parent), no `factory:ready` at all, never one added and removed. |
| `listOpen(ctx, {repo})` | `[{id, title, labels, key, …}]` | Open issues only, with label names. |
| `dependencies(item)` | `[id]` | The ids an item from `listOpen` waits on. |

3. Use it: `F new "<idea>" --tracker <id>`. No core change.

Per-issue reads, optional (a project's tracker is `projects.json` `tracker`, else `github-issues` on a GitHub project and
`local` (local-first 5b) on a git one). Core imports the trackers it reads these from by name (`builtin` in `index.ts`); a tracker without
one is refused by name (`tracker "<id>" cannot …`), and `facts()` turns a missing `trust` into an escalation.

| Function | Returns | Must |
|---|---|---|
| `getItem(ctx, {repo, id})` | `{id, title, url?, author, association, state, isChangeRequest, body}` | The item as written, never model-typed. `association` is the author's standing on the tracker. |
| `comments(ctx, {repo, id})` | `[{author, association, created_at, body}]` | Every comment, oldest first. |
| `trust(ctx, {repo, id})` | the author's association | Read again at merge time by `facts()`. |
| `ensureLabels(ctx, {repo})` | `[name]` | For `F labels`: create the factory's labels where they must exist first. |
| `label(ctx, {repo, id, add?, remove?})` | `{labelled, detail?}` | For `F label`, on the run's own item. Removing a label it doesn't have is fine; any other failure throws. |
| `comment(ctx, {repo, id, body})` | `{posted, detail?}` | For `F comment`. A tracker with no comments returns `posted: false` and says why. |

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

## `local`

A git project's default tracker (local-first D3, D4). Each item is `<clone>/.factory/issues/<N>.md`: front matter with
`title`, `state` and `labels`, then the body as GitHub Issues writes it, so `Depends on #3` and the key marker read the
same. `.factory/issues/` is untracked: `F item new` (or `createIssues`) adds `/.factory/issues/` to the clone's
`info/exclude` once, never the tracked `.gitignore`, and never commits. Only plain files are read or written: a symlinked
`.factory` or `.factory/issues`, an item that is a symlink or a folder, and items git tracks are refused. A new item takes
the next free N with an exclusive create, so two `F` processes never share one. An item has no verifiable author:
`getItem` gives association `NONE` and no comments, and there is no `trust`, so every spec waits for `F approve RUN` at
the user's own terminal and `facts()` escalates. That approval is a speed bump, not a security boundary (local-first
5b); merges don't rest on it.

`label` rewrites the item's front matter (title, state, labels) and keeps its body; `comment` returns `posted: false`, since
an item has no comments, and `ensureLabels` has nothing to create.

## Through the adapter

`F intake`, spec approval and `facts()` read the item through `getItem`, `comments` and `trust`. Intake's writes go
through the rest (local-first PR 6b): `F labels`, `F label` (a closed list), `F comment` (the recorded reason or
questions), `F split` (`createIssues` with `ready` from the parent's recorded trust) and `F similar` (`listOpen`).
