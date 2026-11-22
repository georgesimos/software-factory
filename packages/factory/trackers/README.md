# Trackers

A tracker is where `F issues create` files a project's issue batch, and where `F queue` / `F loop` read open issues and their dependencies. One file per tracker, loaded automatically: `github-issues.mjs` ships. `index.mjs` and files starting with `_` are skipped.

## Add one

1. Copy `_template.mjs` to `<id>.mjs`. The file name must equal `export const id`.
2. Implement the three functions. Each gets `ctx = {gh, git}`:

| Function | Returns | Must |
|---|---|---|
| `createIssues(ctx, {repo, items, existing, onCreated})` | `[{key, id, url, created}]` in item order | Items arrive in dependency order, the epic last. Skip keys in `existing` and keys already in the tracker (store the key somewhere stable; GitHub uses a hidden `<!-- factory-key: k -->` marker). Call `onCreated` right after each create so a crash mid-batch loses nothing. Label every non-epic issue `factory:ready`. ids are strings. |
| `listOpen(ctx, {repo})` | `[{id, title, labels, key, …}]` | Open issues only, with label names. |
| `dependencies(item)` | `[id]` | The ids an item from `listOpen` waits on. |

3. Use it: `F new "<idea>" --tracker <id>`. No core change.

## Test

`node factory.mjs test` runs the shared `contract()` in `index.mjs` against every tracker in this folder (with the fake `gh`), and against a fake tracker written as one file in a temp dir. The contract creates a, b (depends on a) and an epic, re-runs with `existing` and expects zero creates, then checks `listOpen` labels and `dependencies`.

Point `FACTORY_TRACKERS` at another folder to load trackers from there instead.

## Not yet on the adapter

Per-issue intake (`F intake`, stage comments and labels) still calls `gh` directly. Moving it onto this adapter is a follow-up; until then a non-GitHub tracker covers `F issues create`, `F queue` and `F loop` only.
