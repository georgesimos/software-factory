# Plan: split `factory.mjs` into packages

Status: proposal (2026-11-22). The stack decisions behind it are in [ADR 0001](../adr/0001-stack.md). The Windows, macOS and Linux gaps are in the [cross-platform audit](cross-platform-audit.md).

Today the logic lives in three files:
- `packages/factory/factory.mjs` (2,575 lines): event log, derive, decisions, GitHub, worktrees, sync, rules, skills, onboarding, the `F ui` server, the dashboard render, the CLI, and an 830-line self-test;
- `project.mjs` (362 lines);
- `dashboard.html` (1,760 lines of plain JS).

This plan moves them into packages, one reviewable PR at a time, without changing behaviour.

## 1. Target layout

The layout follows the repo's existing convention: libraries go in `packages/` and runnable apps go in `apps/`. `docs/plans/ship-harness.md` already plans `apps/desktop`.

```
packages/
  core/          @software-factory/core      event log, derive, gate/decide/merge, rules, skills, budget, metrics,
                                             worktrees, sync, idea-to-app; zero runtime dependencies
  adapters/      @software-factory/adapters  harnesses/, hosts/, trackers/ (one file per provider, as today) + registry loader
  ship/          @software-factory/ship      unchanged: already its own package, the ship-connector family of adapters
  server/        @software-factory/server    /api/* (from #23 / PR #29), F ui, the page data; Node http, no framework
  cli/           @software-factory/cli       argv -> core/server calls -> JSON on stdout; nothing else
  factory/       the skill                   SKILL.md, references/, evals/, templates/, examples/, factory.mjs (thin entry)
  design-system/ unchanged
apps/
  web/           React 19 app built from design-system: served by the server, loaded by Electron, and built as one file for the Artifact
  desktop/       Electron: launch the factory, watch runs and sessions, launch harnesses
  playground/    unchanged
```

**Dependency direction.** Arrows point from importer to imported. Nothing imports upward.

```
factory.mjs ─► cli ─► server ─► core ─► adapters
                 └──────────────►┘
apps/desktop ─► server (in-process), adapters (launchers), apps/web (build output)
apps/web     ─► design-system; talks to server over HTTP only
core ─► ship  (dynamic import, as today: ship receives record() and never imports core)
```

**`core` is pure where it decides and stubbable where it acts:**
- **Pure:** `derive`, `gate`, `decide`, `risk`, `budget`, `metrics` and the rules and skills validation take data and return data. They get unit tests with no file system.
- **I/O:** the event log store, GitHub calls (`gh`), git worktrees and transcript reading. These keep today's override seams (`FACTORY_DIR`, `FACTORY_GH`, `FACTORY_GIT`).

Injecting `gh`/`git` as parameters everywhere, the way `adapterCtx()` already does for hosts and trackers, is a later refactor. It is **not** part of a move.

### How the thin entry reaches the packages

`SKILL.md`, every session and the dashboard's hints run `node ~/.claude/skills/software-factory/factory.mjs`. That path is a link to `packages/factory` in a clone. After the split, `factory.mjs` is a few lines:

```js
#!/usr/bin/env node
// Entry point kept at this path: SKILL.md and every session call it. All logic lives in ../core, ../server, ../cli.
export * from '../core/src/index.ts';            // project.mjs-era importers and ship keep working
import { main } from '../cli/src/main.ts';
if (isMain(import.meta.url)) await main(process.argv.slice(2));
```

These are **relative imports**, not workspace imports (`@software-factory/core` resolved through `node_modules`):
- **No install step.** Today the skill runs from a fresh clone with nothing but `node`. A workspace import would need `pnpm install` before the first `F` call.
- **No `node_modules` stripping rule.** Node does not strip types from files under `node_modules`. Relative imports never go there.
- **They work through the skill link.** Node resolves the main module's symlink or junction to its real path, so `../core` resolves inside the clone. `factory.mjs` already depends on this for `../ship/ship.mjs`.

The rules that follow:
- `core`, `cli` and `server` keep **zero runtime dependencies**, as `factory.mjs` has today.
- The skill folder is always a **link, never a copy**. `F install-skill` creates a junction on Windows and a symlink elsewhere (see [the audit](cross-platform-audit.md#4-symlinks-and-install)).
- If a copyable single-file skill is ever needed, for example as a plugin package, it becomes a bundled release artifact. That is out of scope here.

## 2. Rules for every move PR

1. **One kind of change per PR.** A PR is one of these, never two:
   - a **move** (code changes place, not content);
   - **typing** (types added to moved code);
   - a **behaviour change**.
2. **The self-test is the oracle.**
   - Step 1 below is the only PR that edits the self-test.
   - From then on, `async function test()` through `worktreeTest` stays byte-identical except for `import` lines, until step 11 splits it into per-module tests.
   - The functions the test calls by name are imported into `factory.mjs` under the same names. Helpers that were private and that the test uses become exports of their new module.
3. **Moved code lands as `.ts` with `// @ts-nocheck` on line 1** and is otherwise identical to the code it replaces:
   - `tsc --noEmit` passes from the first move;
   - the `@ts-nocheck` comes off, module by module, in the typing step;
   - code is erasable-only from the start: `factory.mjs` has no `enum` or `namespace` to strip.
4. **Each move PR proves itself:**
   - `pnpm --filter @software-factory/factory test` passes, which is the oracle;
   - `F demo` derives the same runs before and after: diff `F state` for each demo run, since the dashboard HTML has timestamps;
   - `git diff --color-moved=zebra -M` shows only moved lines, plus `import` and `export` lines;
   - the description lists the old line range of every moved function and where it went.
5. **Regenerate rather than rebase.** A move is mechanical, so it is best produced by a short script, which the PR description includes. When `main` moves, re-run the script on the new `main` instead of hand-merging conflicts in a 2,500-line file.
6. **The factory's gate will escalate these PRs, and a human merge is expected:**
   - the diffs are over `MAX_DIFF` (300 lines);
   - new `package.json` files match `SENSITIVE`;
   - moved source has no test change, by design.
   
   Every step issue says so, so the escalation is not a surprise.
7. **No open PR may touch `factory.mjs` while a move PR is open.** PRs #28–#33 all touch `factory.mjs`. Step 1 waits until they are merged or closed. After that, new feature runs that touch `factory.mjs` wait until step 10 lands, or rebase onto a split that is done. Whether to pause them is an [open question](#6-open-questions-for-the-owner).

## 3. The steps

Arrows show what each step needs merged first. Steps on the same row can run in parallel once their arrows are satisfied. Issue numbers are filled in below.

```
S1 prep ──► S2 scaffold core: log, derive ──┬─► S3 gate/metrics ───────────┐
                                            ├─► S4 skills, rules ─► S6 workspace ─┤
                                            └─► S5 adapters ─────────────────────┴─► S7 GitHub, sync ─► S8 project, onboard, demo
                                                                                                      ─► S9 server (needs #23) ─► S10 cli, thin entry ─► S11 split tests
X0 CI matrix (now) ·  X1 spawn, X2 shells/paths/open/install, T1 typing (after S10) ·  X3 Windows-safe tests (after S11)
W1 web (now) ─► W2 web parity (after S9) ─► W3 single-file build, retire dashboard.html
D1 desktop (after S9, W1) ─► D2 terminal pane (after H1) ·  H1 harness launch contract + Claude Code (after S5, S9; builds on #25, #26) ─► H2 Codex
```

### Split (moves only)

Line ranges are from `b9f4e87`.

| Step | Moves | From `factory.mjs` |
|---|---|---|
| **S1 Prep, in place** | No move. In `factory.mjs` itself: (a) replace the module-level `let DIR`, `GH`, `GIT` and `PROJECTS` with one exported mutable `env` object, because another module cannot reassign an imported binding and the test reassigns all four, so the ~15 `DIR = …`/`GH = …` assignments in the test, `evals`, `demo` and the `demo` command become `env.dir = …`; (b) the eight `render()` calls in code bound for `core` (`record`, `setAutoMerge`, rule `audit`, `sync`, `archive`, `setShip`, `demo`, and `project.mjs`) call `hooks.render()`, which the entry point sets to `render`, so they can move to `core` while `render` moves to `server`; (c) drop `env -u` from `package.json` and `delete process.env.CLAUDE_CODE_SESSION_ID` at the top of `test()`. After this PR the oracle is frozen. | 16–20, 71–104, 221, 1561–1972 (test assignments) |
| **S2 Scaffold core; log and derive** | `packages/core` with `package.json`, `tsconfig.json` (§4) and `src/index.ts`. Moves `env`, constants, `runDir`, `read`, `record`, `archive`, `validateUsage`, `addBurn`, `validateReview`, `derive` and `budget`. | 16–69, 71–219, 1208–1225 |
| **S3 Decisions and metrics** | `axesFor`, `reviewAxes`, `gate`, `decide`, `risk` and `metrics`. Measured burn (`scanFile`, `measure`, `withMeasured`) goes to `core/burn.ts`. | 220–431, 1248–1273 |
| **S4 Skills, rules, review input** | Runner config and catalog (`checkRunner` … `skillsData`), `setAutoMerge` and rules, `headlessArgs`, `runnerStamp` and `reviewFromText`. | 432–590, 651–821 |
| **S5 Adapters package** | `harnesses/`, `hosts/`, `trackers/` and `registry.mjs` move to `packages/adapters`, keeping `.mjs` this time. The loaders filter on `.mjs` (`registry.mjs:8`, `harnesses/index.mjs:26`), and `HARNESSES.md` and the hosts and trackers READMEs name the paths, so the move updates them. `FACTORY_HOSTS`, `FACTORY_TRACKERS` and `FACTORY_HARNESSES` keep working. Converting the adapters to `.ts` is part of T1, together with letting the loaders accept `.ts`. | folders + 12–14 imports |
| **S6 Workspace** | `git`, `projects`, `worktree`, `cleanup`, `gc`, `deps` and `localChecks`. | 858–941, 1112–1136 |
| **S7 GitHub and sync** | `gh`, `parseRun`, `intake`, `intakeFixture`, `openPRs`, `facts`, `merge`, `approval`, `postmerge`, `revert`, `sessionsByBranch`, `discover`, `loadShip`, `shipTrack`, `sync` and `evals`. | 814–857, 942–1111, 1137–1207, 1226–1247 |
| **S8 Idea-to-app, onboarding, demo** | `project.mjs` becomes `core/src/project.ts`. Its cycle with `factory.mjs` ends because it now imports from `core` modules. Also moves `setShip`, onboarding (`onboardConfig`, `onboardState`, `onboardText`) and `demo`/`demoTranscripts`. | `project.mjs`, 1304–1559 |
| **S9 Server** | `uiHandle`, `UI_ROUTES`, `ui`, `page` and `render` go to `packages/server`. This includes PR #29's `/api/*`, so S9 waits for #23 to merge. | 591–650, 1274–1303 |
| **S10 CLI and thin entry** | The command switch and usage text go to `packages/cli/src/main.ts`. `factory.mjs` becomes the entry above plus the self-test, which still lives there. `SKILL.md` and the `bin` path are unchanged. | 2389–2575 |
| **S11 Split the self-test** | The self-test moves into per-module `node:test` files next to the code: `core/test/derive.test.ts`, and so on. `factory.mjs test` keeps working as an alias for `pnpm test`. This is the step where the oracle stops being one function. Its proof is that every old assertion appears in a new test file: count `assert` calls before and after. | 1560–2388 |

### Cross-platform fixes

Each fix is a behaviour change, so it comes after the moves. Each lands on one module instead of conflicting with a move. The details are in [the audit](cross-platform-audit.md).

| Step | What |
|---|---|
| **X0 CI matrix** | GitHub Actions on `ubuntu-latest`, `macos-latest` and `windows-latest` with Node 24 and Node 26 runs `pnpm install && pnpm test`. The Windows job is `continue-on-error` until X3 lands. It touches `.github/workflows`, which is `SENSITIVE`, so a human merges it. It does not depend on the split. |
| **X1 Spawning** | `core/src/platform.ts` gets `exec()`. It uses no shell on any OS. On Windows it resolves `PATHEXT`. An `.exe` runs directly. A `.cmd` shim runs through `cmd.exe /d /s /c`, and only when its arguments contain no shell metacharacters. It never uses `shell: true`, which is deprecated with arguments (DEP0190). Every bare spawn in audit §1 goes through it. |
| **X2 Shells, paths, open, install** | Audit §2–§5: <ul><li>`localChecks` runs through Git Bash on Windows, or refuses;</li><li>`deps` copies with `fs.cpSync` and `COPYFILE_FICLONE`;</li><li>brief paths accept a drive path and `~\`, and paths with spaces;</li><li>`F_CMD` prints the real path;</li><li>`deepCwd` accepts a drive path;</li><li>`SKIP_DIRS` adds `AppData`;</li><li>`relPath` rejects `\` and drive letters;</li><li>`F open` and `F install-skill` are added;</li><li>install hints are per-OS;</li><li>`SKILL.md` says `F open dashboard`.</li></ul> |
| **X3 Windows-safe tests** | The tests use `path.delimiter`, set `USERPROFILE` as well as `HOME`, and give each stub executable a `.cmd` twin. Then the Windows CI job becomes required. |
| **T1 Type the moved code** | One module per PR: drop `// @ts-nocheck` and add types. `packages/design-system/src/factory/model.ts` becomes the source of the `Run`/`Metrics` shapes, or `core` exports them and design-system imports them. Settle that in the first T1 PR. Adapters convert to `.ts` here. |

### UI and harnesses

| Step | What |
|---|---|
| **W1 Web app** | `apps/web`: Vite with React 19 and `@software-factory/design-system`, showing the board and run detail. It reads the same JSON that `page()` injects today (`__FACTORY_DATA__`), so it works before the server split. When served, it also reads `GET /api/runs`. `apps/playground`'s `Board` and `RunDetail` are the starting point. No dependency. |
| **W2 Web parity** | It reaches `dashboard.html`'s features: the Skills sheet, rules, onboarding wizard, sessions, theme, panel width, collapse and focus, and the actions from #27. It runs through `/api/*` when a server is present and is read-only when it is not. Needs S9. |
| **W3 One build, three hosts** | A single-file build (inlined JS, CSS and fonts) with the data injected: <ul><li>`F render` writes it in place of `dashboard.html`;</li><li>the private Artifact (#18) is published from it;</li><li>`F ui` and Electron serve the normal build.</li></ul> `dashboard.html` is then deleted. Whether the file must still open as `file://` is an [open question](#6-open-questions-for-the-owner). |
| **D1 Desktop shell** | `apps/desktop`: Electron, where the main process imports `@software-factory/server` in-process and loads the web build with the loopback token. The main process is bundled with Vite: a packaged app puts packages under `node_modules`, where Node does not strip types. It is packaged for macOS, Windows and Linux. Needs S9 and W1. |
| **H1 Harness launch contract, Claude Code** | An optional `launch()` in the harness adapter contract with three modes: <ul><li>`terminal`: interactive, through `node-pty`;</li><li>`headless`: a stream of events;</li><li>`sdk`: the Agent SDK.</li></ul> Plus `openDesktop`, which opens the Claude desktop session link. It is exposed as `/api/sessions`. It generalises #25 (headless start) and #26 (open/resume) rather than duplicating them. Needs S5 and S9. |
| **D2 Terminal pane** | An xterm.js view in Electron over H1's `terminal` mode, with a session list next to the runs. Needs D1 and H1. |
| **H2 Codex** | The same contract for Codex: `codex exec --json` for headless, `codex app-server` (JSON-RPC over stdio) for a long-lived session, and the Codex TS SDK. Needs H1. |

## 4. TypeScript settings for Node-run packages

`core`, `cli`, `server` and `adapters` are run by Node directly, with no build. Their `tsconfig.json` extends `tsconfig.base.json` and overrides these settings:

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "nodenext", "moduleResolution": "nodenext", // Node's own resolution, not the bundler's
    "lib": ["ES2024"], "types": ["node"],                // no DOM in Node packages
    "erasableSyntaxOnly": true,                          // rejects enum, namespace, parameter properties
    "verbatimModuleSyntax": true,                        // type-only imports must say `import type`
    "allowImportingTsExtensions": true, "noEmit": true,  // `import './x.ts'`, as Node requires
    "target": "esnext"
  }
}
```

Each Node package gets `"engines": { "node": ">=24.12" }`, matching the minimum version in the ADR. `apps/web` and `apps/desktop`'s renderer keep the bundler settings from `tsconfig.base.json`.

## 5. Issues

| Step | Issue | Ready now |
|---|---|---|
| S1 | _filled in after creation_ | |

## 6. Open questions for the owner

1. **Does the dashboard still need to open as a plain `file://`?** If not, W3 can drop the single-file build for local use and keep it only for the Artifact, and `F render` can stop rewriting a file on every `record()`.
2. **Nx: in or out?** The owner said out, and `docs/architecture.md` says plain pnpm workspaces. Uncommitted changes in the main checkout, from the design-system session, add `nx` and `nx.json`. This plan assumes no Nx. Nothing in it needs Nx, because `pnpm -r` covers seven packages.
3. **Pause new feature runs until S10?** Every feature that touches `factory.mjs` conflicts with every move. The options:
   - (a) pause such runs from S1 to S10, about ten mechanical PRs;
   - (b) let them run, and regenerate the open move PR after each merge (rule 5).
   
   S1 also needs #28–#33 merged or closed first.
