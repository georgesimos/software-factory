# Software Factory architecture

The Software Factory turns a GitHub issue into a merged pull request, or into a clear escalation to a human. It has two halves:

- **The orchestrator** is [`SKILL.md`](../packages/factory/SKILL.md), a Claude Code skill. Its prose tells the driving Claude session what to do at each stage.
- **The judge and record-keeper** is [`factory.mjs`](../packages/factory/factory.mjs), a zero-dependency Node CLI called `F` below. It records every state change, makes every mechanical decision, and is the only code allowed to merge.

The model does the creative work: intake judgement, the spec, the code and the reviews. `F` decides whether that work is allowed through.

> All file names, constants and outputs in this document come from the code as of this commit. Run `node packages/factory/factory.mjs` for the current command list.

---

## 1. Folder structure

```
software-factory/
├── package.json              pnpm workspace root: build / test / contrast / tokens / dev scripts
├── pnpm-workspace.yaml       workspaces: packages/*, apps/*
├── pnpm-lock.yaml
├── tsconfig.base.json        shared TS settings for the TS packages
├── .gitignore                node_modules, dist, .env* (keeps .env.example), .claude/
├── LICENSE                   Apache-2.0
├── README.md
├── scripts/
│   └── scrub-factory.sh      re-runnable scrub of personal branch names in factory test fixtures
├── docs/
│   ├── architecture.md       this file
│   └── research/
│       ├── ai-engineering-flows.md   survey of AI engineering flows + gap list vs the factory
│       ├── factory-efficiency.md     storage, speed and token levers for the pipeline
│       └── tauri-vs-electron.md      desktop shell comparison (Electron chosen)
├── packages/
│   ├── factory/              @software-factory/factory: the skill. ~/.claude/skills/software-factory symlinks here
│   │   ├── SKILL.md          orchestration: modes, ground rules, stages 0–7, attach, evals, scheduling
│   │   ├── factory.mjs       the F CLI: event log, derive, gate/decide/merge, sync, worktrees, dashboard render, self-test
│   │   ├── project.mjs       idea-to-app: F new, issues create, queue, loop, project (imported by factory.mjs)
│   │   ├── registry.mjs      loads one-file-per-provider folders (hosts/, trackers/)
│   │   ├── hosts/            repo hosts: github.mjs, _template.mjs, index.mjs (contract), README.md (recipe)
│   │   ├── trackers/         issue trackers: github-issues.mjs, _template.mjs, index.mjs (contract), README.md
│   │   ├── templates/        stack templates, data only: next-web.json, expo-mobile.json, _template.json, README.md
│   │   ├── examples/
│   │   │   └── budget-app/   PLAN.md + issues.json for "a personal budget app", and the F new --dry-run output
│   │   ├── dashboard.html    static dashboard template; F render injects the run data at __FACTORY_DATA__ (also the setup wizard)
│   │   ├── harnesses/        AI harness registry (index.mjs) auto-loads every *.mjs except _*: claude-code.mjs, codex.mjs, _template.mjs
│   │   ├── HARNESSES.md      add a harness in 4 steps
│   │   ├── references/
│   │   │   └── reviewers.md  per-axis reviewer briefs (code, security, ux, ui, seo, docs) and the verifier brief
│   │   ├── evals/golden/     1.json … 8.json: intake fixtures with the expected outcome (pass / needs-info / reject / split)
│   │   ├── test/
│   │   │   ├── gh-stub.mjs   fake `gh` used by the self-test (FACTORY_GH)
│   │   │   ├── git-stub.mjs  fake `git branch --no-merged` used by the sync test (FACTORY_GIT)
│   │   │   ├── bin/          fake `claude` and `codex` for the harness contract test (one stub per harness)
│   │   │   ├── gh-project-stub.mjs  stateful fake `gh` (repos, labels, issues) for the idea-to-app test
│   │   │   ├── project.mjs   idea-to-app self-test: commands, idempotency, queue, loop stops, adapter contracts
│   │   │   └── onboard.e2e.cjs  Playwright run of the setup wizard against F ui (375/1280 px, light/dark, static file)
│   │   └── package.json      private; `test` = env -u CLAUDE_CODE_SESSION_ID node factory.mjs test
│   ├── ship/                 @software-factory/ship: the ship harness (phase 0, read only). See docs/plans/ship-harness.md
│   │   ├── ship.mjs          CLI (`F ship` is an alias): connectors | detect <repo> | status <repo> [sha]; track() records through F's record()
│   │   ├── contract.mjs      connector contract: id, kind, detect, auth, status, tagged actions; normalized states per kind; validation
│   │   ├── connectors/       registry (index.mjs) auto-loads every *.mjs except _*: github-deployments.mjs, _template.mjs
│   │   ├── CONNECTORS.md     add a provider in 4 steps
│   │   └── test/             shared contract test over every connector + fixtures/<id>.json, plus a fake one-file provider
│   └── design-system/        @software-factory/design-system: tokens + React components for the desktop app
│       ├── src/tokens.ts     source of truth for colour, type and spacing tokens
│       ├── src/tokens.css    generated from tokens.ts (scripts/tokens-css.ts, checked in build)
│       ├── src/components/   generic primitives: Button, Card, Dialog, Table, Tabs, Toast, Tooltip…
│       ├── src/factory/      factory-specific views: RunCard, StageTrack, ReviewMatrix, Timeline, OutcomePill…
│       │   └── model.ts      TypeScript types for the JSON that derive() / metrics() / sync() emit
│       ├── src/onboarding/   ProjectPicker (discover results) and IngestProgress (sync progress)
│       ├── src/index.ts      package entry; styles.css / base.css / fonts.css are the CSS entry points
│       ├── src/fonts/        Geist + Geist Mono (OFL)
│       ├── test/             Vitest + Testing Library tests
│       └── scripts/contrast.ts  WCAG AA contrast check over every token pair (`pnpm contrast`)
└── apps/
    └── playground/           Vite playground: tokens, components, onboarding, board and run-detail mocks (`pnpm dev`)
```

**Monorepo tooling.** The repo uses plain pnpm workspaces, with no Nx or Turborepo; at this size they would add config and caches without real speed-up. Add Turborepo (one `turbo.json`) if builds get slow. Root `pnpm test` runs the contrast check, then `pnpm -r test` across every package, which includes the factory self-test.

**Runtime state is not in the repo.** It lives in `~/.claude/factory/` and is never committed (see [§3](#3-data-model)).

---

## 2. Components

### 2.1 The skill: `SKILL.md`

`SKILL.md` is loaded by Claude Code when the user says "software factory", "factory this issue", "attach/sync … to the factory", or passes `owner/repo#N`. It defines:

- **Modes:**
  - build an issue end to end;
  - `--dry-run --intake-only`;
  - `sync`;
  - `next`, `triage`;
  - `sweep dead-code|coverage`.
- **Ground rules.** Untrusted text is data. JSON payloads go on stdin through a quoted heredoc. `F` records every change, and `F merge` is the only merge path. Mechanical decisions are final.
- **Stages 0 to 7:** setup and resume, intake, spec, build, review, gate, approve, then watching main after a merge.
- **Subagent fan-out for review.** One fresh subagent per axis, all in a single message, given a fixed brief order so the prompt cache hits. `ui`, `seo` and `docs` reviewers and the verifier run on `sonnet`. `code`, `security` and `ux` run on the default model.

The skill never writes state itself. It runs `F` subcommands and acts on their JSON output.

### 2.2 The `F` CLI: `factory.mjs`

`factory.mjs` is a single ESM file with no dependencies beyond Node built-ins. It shells out to `gh` and `git` through `execFileSync`, never through a shell. Its responsibilities:

| Area | Commands | Notes |
|---|---|---|
| Event log | `event`, `state`, `dir` | `record()` validates the stage and status, appends to `events.jsonl`, and re-renders the dashboard on every write. |
| Intake | `intake` | Fetches the issue from GitHub so title, author and association are never typed by the model. |
| Spec gate | `risk`, `approval` | Untrusted authors and sensitive planned files require `/factory approve`. |
| Build | `worktree`, `deps`, `gc` | One git worktree per run; the cheapest available way to get `node_modules`. |
| Review | `axes`, `review` | `axes` picks the review axes from the diff (plus configured extra axes) and records the reviewed commit SHA. `review` records one reviewer's raw output; anything outside the contract becomes a failed review. |
| Runners | `skills`, `skills set`, `skills unset`, `skills catalog`, `ui`, `headless-args` | Who does each step: the built-in brief, the user's skill or brief, or a Claude Code / Codex tool. `ui` serves the dashboard on loopback so its Skills sheet can save. `headless-args` prints the pinned `claude -p` flags for a provider runner. See [§5.1](#51-runners). |
| Decisions | `gate`, `decide`, `merge` | Pure functions over derived state plus live GitHub facts. |
| After merge | `postmerge`, `revert` | Watches CI on the merge commit; opens a revert PR, never merges it. |
| Onboarding | `discover`, `sync`, `projects`, `automerge` | Finds local clones, imports open PRs and agent sessions. |
| Rules | `rules`, `rules set`, `rules unset`, `checks` | Per-project or global policy switches and step guidance; local checks that stand in for CI. See [§5.2](#52-rules). |
| Idea to app | `new`, `issues create`, `queue`, `loop`, `project` | In `project.mjs`. Validates the plan and issue batch Claude wrote, creates the repo and issues through the host and tracker adapters only with `--yes`, and picks the next issue in dependency order. See [§7.7](#77-start-from-an-idea). |
| Housekeeping | `archive`, `render`, `demo`, `test`, `eval` | `eval` runs headless `claude -p` over the golden fixtures and costs tokens. |

Environment overrides:

- `FACTORY_DIR`: the state folder. The default is `~/.claude/factory`.
- `FACTORY_GH` and `FACTORY_GIT`: stubs, used by the self-test only.
- `FACTORY_FIXTURES`: offline eval issues.
- `FACTORY_HOSTS`, `FACTORY_TRACKERS` and `FACTORY_TEMPLATES`: load repo hosts, trackers or stack templates from another folder.

### 2.3 The event log

The log is an append-only JSONL file, and it is the source of truth. Everything else is derived from it or is a cache. See [§3](#3-data-model).

### 2.4 The dashboard

`dashboard.html` is a self-contained static page. On every `record()`, `F render`:

1. derives all runs, live and archived;
2. merges in the session links from `sessions.json`;
3. computes metrics overall and per project: merge rate, average iterations, median cycle time, revert rate, cost per merge;
4. writes `~/.claude/factory/dashboard.html` with the data inlined as JSON.

Every `<` in that JSON is written as the escape sequence backslash-u-003c, so issue titles cannot break out of the script tag; the self-test asserts this. The page filters by project, and each run's detail has Pipeline, Review, Decision, Loop-backs, Sessions and Timeline sections; a split parent also gets an Epic section listing its children. For each linked agent session it offers a **Copy resume** button, which copies `cd '<cwd>' && claude --resume <id>` for Claude Code or `codex resume <id>` for Codex. The working directory is single-quoted for the shell. Ids that don't match `[\w.-]+` get no button. Above the sessions, an **Open in Claude** link (`claude-cli://open?cwd=…&q=…`) opens a new Claude Code terminal in the run's worktree (`worktree` in the page data, from `worktree.json`), or else the latest session's `cwd`, with "Continue factory run <id>. Run F state '<id>' first." pre-filled but not sent. Both values are `encodeURIComponent`-encoded; the path must be absolute with no `..` and no control or bidi characters, and the run id must look like `owner/repo#N` or `owner/repo:branch`, or there is no link. The handler exists only after the user has sent one message in an interactive `claude` session, which the tooltip says. Every other link stays `https:`-only. Each run card shows an "N sessions" chip when sessions are linked. When a step or a review axis was run by something other than the built-in brief, the pipeline stage or the review-matrix cell shows a small runner chip, such as `skill: brand-review` or `codex`, with a fallback reason in its tooltip. A theme switch offers System, Light and Dark; the choice is stored in `localStorage` under `factory.theme` and applied by an inline script before first paint, so there is no flash of the wrong theme.

On screens 1100 px and wider, the run detail is a docked column beside the board. It is open by default, and with no run selected it shows a "Select a run" state. The column is about 44% of the viewport, clamped to 480–760 px. Drag its edge or use the arrow keys on the focused edge to resize it. Collapse it with the header toggle or the `]` key, and use **Focus** to widen it to most of the screen. Width, collapsed state and focus mode persist in `localStorage` under `factory.panelW`, `factory.panelCollapsed` and `factory.panelFocus`. Choosing a run always re-opens a collapsed column. Below 1100 px the detail becomes a full view. Esc closes the run and returns focus to its card.

### 2.5 The design system: `packages/design-system`

The design system holds tokens in `tokens.ts`, from which CSS is generated, plus a WCAG AA contrast check and React components. The components come in two groups:

- **generic primitives** in `src/components/`;
- **factory views** in `src/factory/`, typed against `src/factory/model.ts`, which mirrors the JSON that `derive()`, `metrics()`, `discover()` and `sync()` emit.

The design system is the UI kit for the planned app. The current `dashboard.html` does not use it yet.

### 2.6 The planned app (not built)

The app is planned to be local-first. Its pieces:

- **Electron + Vite/React shell.** See [research/tauri-vs-electron.md](research/tauri-vs-electron.md) for why Electron over Tauri.
- **Views** built from `@software-factory/design-system`.
- **`F serve` (planned; not in `factory.mjs` yet):** a loopback-only HTTP server that serves `derive()` output and streams new events over Server-Sent Events, so the app updates live instead of re-reading the static page.
- **`factory.mjs` stays the only writer.** The app reads through `F serve` and acts by invoking `F` commands, the same contract the skill follows. It never edits `events.jsonl`.

---

## 3. Data model

### 3.1 `~/.claude/factory/events.jsonl` (append-only)

Each line is one event:

```json
{"ts":"2026-11-20T09:01:37.000Z","title":"Make the site support crypto payments","url":"https://github.com/acme/shop/issues/41","author":"drive-by","association":"NONE","run":"acme/shop#41","stage":"intake","status":"started"}
{"ts":"2026-11-20T09:03:14.000Z","reason":"Out of scope: the roadmap excludes payment providers and the issue has no user need behind it.","run":"acme/shop#41","stage":"intake","status":"rejected"}
```

- **`run`**, the run id, takes one of two forms:
  - `owner/repo#N` for an issue or an imported PR (they share GitHub's number space);
  - `owner/repo:<branch>` for an imported agent session that has no PR yet.
- **`stage`** is one of `intake | spec | build | review | gate | approve`. `ship` records deploy state: `{run, stage: "ship", status: "passed|failed|started", connector, kind, env, state, url?, sha, at?, detail?, creator?}`, written only by `packages/ship`'s `track()` through `record()` (from `F sync`, `F postmerge`, and `F decide`/`F merge` under `deploy.preview`). `F event` refuses that stage and those fields, and ship events carry no session stamp. Another stage, `rules`, marks a rule change rather than a run event: `{run: "<owner/repo|default>", stage: "rules", status: "set|unset", key, value?, reason?, until?, setBy}`. `derive()` skips these, `archive()` keeps them, and the dashboard shows them as rule history.
- **`status`** is one of `started | passed | failed | decided | reverted`, or one of the outcomes `rejected | needs-info | merged | escalated | closed | awaiting-approval | split`.
- **The payload** is spread into the event: for example `summary`, `spec`, `pr`, `branch`, `axes`, `sha`, `range`, `axis`, `findings`, `reasons`, `next`, `action`, `facts`, `tokens` and `costUsd`. `F checks` records `build passed|failed` with `localChecks: {state, sha, commands: [{cmd, exit, ms}]}`, and `derive()` keeps the latest as `r.localChecks`.
- **Runner stamp.** When `skills.json` names a non-default runner for the step (`intake`, `spec`, `build`, `review.<axis>` or an extra axis, `verifier` for `gate` events), `record()` adds `runner: {use, name?, path?, harness?}`. A `--fallback "<why>"` flag records `runner: {use: "default", fallback: {from, reason}}`. Default runners add nothing.
- **Harness stamp.** When `CLAUDE_CODE_SESSION_ID` is set, `record()` adds `harness: "claude-code"`, `sessionId` and `cwd`. That is how a run links back to the session driving it.

The CLI never rewrites the log, with one exception: `archive` rewrites it by write-then-rename, keeping `events.jsonl.bak`.

### 3.2 `derive(events)`: run state

`derive()` is a single left fold over the events, producing `{ [runId]: run }`. For each run:

| Field | Derived from |
|---|---|
| `stage`, `status`, `updated`, `started`, `durationMs` | the last event, the first event, and the difference between them |
| `title`, `url`, `pr`, `branch`, `spec`, `issues`, `children` | the latest non-empty value. A `reverted` event's `pr` does not replace the run's PR. |
| `author`, `association`, `source`, `imported`, `origin`, `originAssociation` | **only** from `intake started` events, which `F intake` and `F sync` write from GitHub data |
| `iteration` | +1 on each `build started` |
| `axes[iteration]`, `reviewedSha` | `review started`, which `F axes` writes |
| `runners[stage]` | the `runner` of the stage's latest event (absent for default runners) |
| `reviews[iteration][axis]` | `{verdict, findings, runner?}`. The **verdict is recomputed from the findings**: any undismissed high or medium finding means `failed`, whatever the reviewer wrote. |
| `loopbacks[]` | `gate` events whose `next` is `spec` or `build` |
| `decision` | the last `approve decided` |
| `outcome` | the last outcome status. It resets to `in-progress` on a new `intake started` (a resume after needs-info), and leaves `awaiting-approval` on the next non-outcome event. |
| `reverted` | `{pr, reason}` from `approve reverted` |
| `costUsd`, `tokens` | summed from every event that reports them |
| `sessions[]` | distinct `sessionId`s with their last-seen time |
| `parent` | set on a split child from the parent's `children` |
| `deploys[]` | `ship` events: the latest `{connector, kind, env, state, status, url, sha, at, detail}` per connector and env. They never change the run's `stage`, `url`, `updated` or `outcome`. |

`TERMINAL` outcomes are `rejected`, `merged`, `escalated`, `closed` and `split`. `needs-info` and `awaiting-approval` are parked states that resume.

### 3.3 Side files in `~/.claude/factory/`

| File | Written by | Contents |
|---|---|---|
| `projects.json` | `sync`, `worktree`, `automerge` | `{ "owner/repo": { path, synced, autoMerge? } }`, mapping each attached project to its local clone |
| `skills.json` | `skills set`, `rules set/unset`, or by hand | `{ "default": {step: runner}, "owner/repo": {step: runner, "axes.extra": [...], "rules": {key: {value, reason, setBy, setAt, until?}}, "guide": {step: text}} }`. Validated on every read. See [§5.1](#51-runners) and [§5.2](#52-rules). |
| `onboard.json` | `onboard ship`, the setup wizard | `{ "default" \| "owner/repo": { ship: ["web", "mobile", "database"] } }`: what a project ships. The choice only; connectors come from `packages/ship` |
| `sessions.json` | `sync` | `{ runId: [ {agent, id, cwd, last} ×≤5 ] }`, linking runs to local Claude Code and Codex sessions by branch |
| `archive.jsonl` | `archive` | one compact run per line (derived state plus its last 5 events, `archived: true`) for finished runs older than N days (default 14) |
| `events.jsonl.bak` | `archive` | the log as it was before the last archive |
| `dashboard.html` | `render`, called after every `record()` | the generated dashboard |

### 3.4 Per-run folder: `runDir = ~/.claude/factory/<run id with non-alphanumerics → "-">`

| Path | Purpose |
|---|---|
| `spec.md` | the spec (Goal, Non-goals, Acceptance criteria, Files, Test plan, Risks, `## Changes` on a loop-back) |
| `checks.json` | `{lint, typecheck, tests, build, notes}`. Reviewers read this instead of re-running the checks. Written by the model, so nothing mechanical reads it. |
| `local-checks.log` | output of the last `F checks`; its tail is printed on failure, never logged |
| `worktree.json` | `{repoPath, path, branch, base}` |
| `wt/` | the run's **git worktree** on branch `factory/issue-N`. It shares the clone's object store and is created from `origin/factory/issue-N` when that branch exists (resume) or `origin/<base>` otherwise. |
| `revert/` | a temporary worktree for `F revert`, always removed afterwards |

**Worktree cleanup.** Reaching a terminal outcome or `needs-info` runs `cleanup()`. It removes the worktree and its local branch **unless** the worktree has uncommitted changes or unpushed commits, in which case it is kept and a warning is printed. `F gc` sweeps the worktrees left behind by finished runs.

**Dependencies.** `F deps` picks the cheapest way to get `node_modules`:

- a pnpm lockfile: `pnpm install --frozen-lockfile --prefer-offline`, hard-linked from the store;
- the same npm or yarn lockfile as the main clone and no workspaces: a copy-on-write clone of the main `node_modules` (`cp -c` on macOS, `--reflink=auto` elsewhere);
- otherwise an offline-first install.

---

## 4. Pipeline flow

```mermaid
flowchart TD
  A(["owner/repo issue N"]) --> S0["Stage 0 · Setup<br/>F gc, labels, F state → resume point"]
  S0 --> I["Stage 1 · Intake<br/>F intake: issue + trusted comments only"]
  I -->|"open PR already closes the issue"| STOP1(["stop: in progress elsewhere"])
  I -->|"reject"| REJ(["rejected · factory:rejected"])
  I -->|"needs-info"| NI(["needs-info · numbered questions"])
  NI -.->|"new comments, re-run"| I
  I -->|"split"| SPL(["split · child issues, each 'Part of' the parent"])
  I -->|"pass"| SP["Stage 2 · Spec<br/>DIR/spec.md, then F risk"]
  SP -->|"risky: untrusted author or sensitive paths"| AW(["awaiting-approval · factory:needs-approval"])
  AW -->|"trusted /factory approve"| B
  AW -->|"/factory reject"| REJ
  SP -->|"not risky"| B["Stage 3 · Build in DIR/wt<br/>branch factory/issue-N<br/>F deps, tests, checks.json, push, draft PR"]
  B --> CI{"CI green?<br/>gh pr checks --watch"}
  CI -->|"red: fix, at most 2 times"| B
  CI -->|"still red"| ESC
  CI -->|"green"| AX["Stage 4 · Review<br/>F axes → axes + reviewed SHA"]
  AX --> R["one subagent per axis, in parallel<br/>code · security · ux · ui · seo · docs"]
  R --> V["verifier: keep or dismiss<br/>each high or medium finding"]
  V --> G{"Stage 5 · F gate"}
  G -->|"blocking finding routed to spec, under the caps"| SP
  G -->|"blocking findings routed to build, under the caps"| B
  G -->|"all passed, or a cap hit: 3 loops, $5, 3M tokens"| M{"Stage 6 · F merge<br/>re-decide from live GitHub"}
  M -->|"every condition holds"| MG["gh pr merge --squash<br/>--match-head-commit reviewedSha"]
  M -->|"any condition fails"| ESC(["escalated · factory:needs-human"])
  MG --> PM{"Stage 7 · F postmerge<br/>CI on the merge commit, up to 20 min"}
  PM -->|"pass"| DONE(["merged · factory:merged"])
  PM -->|"fail"| RV["F revert → revert PR<br/>factory:needs-human, never auto-merged"]
```

**Review axes** (`axesFor(files)`):

- `code` and `security` always run.
- `ux` and `ui` run if any UI file changed (`.tsx .jsx .vue .svelte .astro .html .css …`).
- `seo` runs for page, layout, metadata, sitemap or robots files and `pages/`.
- `docs` runs for `.md`/`.mdx`, `.env.example`, and API, route, CLI and bin paths.

On a loop-back, `reviewAxes()` re-reviews only the axes the new commits touch, plus every axis that did not pass last time. The diff range is `reviewedSha...HEAD`.

**Gate** (`gate(r)`):

1. It refuses to run if any selected axis has no verdict.
2. If every axis passed, it returns `next: approve`.
3. Otherwise it routes to `spec` if any blocking finding has `route: "spec"`, and to `build` if not.
4. If `iteration >= 3`, or the cost is over $5, or the tokens are over 3M, it returns `next: approve` instead, so the run stops looping and escalates.

**Merge decision** (`decide(r, facts)`). The default is to escalate. The run merges only when **all** of these hold:

- it is not an imported run;
- the live author association is `OWNER`, `MEMBER` or `COLLABORATOR`;
- a split's origin author is trusted;
- auto-merge is on for the project;
- every selected axis passed;
- CI is `pass`;
- the diff is 300 lines or fewer (additions plus deletions);
- no sensitive paths are touched;
- `iteration <= 3`;
- the run is within budget;
- if source files changed, a test file changed too;
- a PR is recorded.

`F merge` then runs `gh pr ready` and `gh pr merge --squash --delete-branch --match-head-commit <reviewedSha>`, so a push after review makes GitHub refuse the merge.

---

## 5. Trust model

| Mechanism | Where | What it prevents |
|---|---|---|
| **Trusted associations read live** | `TRUSTED = OWNER, MEMBER, COLLABORATOR`. `facts()` re-reads `author_association` from GitHub at merge time, and the live value wins over the logged one. | A role change, or a forged log value, that would turn on auto-merge |
| **Untrusted issue text** | `F intake` returns only the body and the comments from the issue author or trusted associations; all others are counted as `ignoredComments`. `SKILL.md` and `reviewers.md` treat all issue, PR, diff and reviewer text as data. | Prompt injection ("skip review", "merge now") and drive-by comments that steer requirements |
| **Owned events** | `F event` refuses `intake started` (owned by `intake`), `review started` (`axes`), every `gate` event (`gate`), `approve decided/merged` (`merge`), `approve reverted` (`revert`) `approve closed` (`sync`) and every `rules` event (`rules`). `record()` itself refuses `merged` unless the recorded decision is `merge`. | The model recording its own approval or a merge |
| **Typed fields** | `F event` rejects payloads that carry `association`, `originAssociation`, `origin`, `author`, `sha`, `imported`, `source`, `action`, `harness`, `sessionId`, `cwd`, `runner` or `localChecks`. These only come from GitHub, git, the harness, `skills.json` or `F checks`. | Spoofed trust, provenance, session links or runner |
| **Review contract** | `validateReview()` rejects unknown fields, an axis outside this iteration's selection, a severity other than `high`/`medium`/`low`, a route other than `spec`/`build`, an empty `issue`, and a `failed` verdict with no blocking finding. `derive()` recomputes the verdict from the findings. | Reviewer output smuggling text or a misleading verdict |
| **Verifier** | Its dismissals are stored as `dismissed: "<reason>"`. A dismissed finding stays visible but does not block. | False positives blocking the gate, without hiding them |
| **Sensitive paths** | `SENSITIVE` matches auth, login, session, oauth, payments, billing, money and migrations; `.github/workflows/`; package manifests and lockfiles (npm, pnpm, yarn, bun, pip, poetry, Gemfile, Go, Cargo); `.env*`; `.claude/**` and `.codex/`, whose settings, hooks, skills and agents a headless runner in the worktree would load; and `.mcp.json`. Without `--bare`, `claude -p` runs a repo's hooks and MCP servers with no trust prompt. `risk` checks them before the build, `decide` after. | Auto-merging changes to security, money, CI or the supply chain |
| **Split inheritance** | A child of a split records its parent's `origin` and `originAssociation`, so an untrusted parent makes the child risky and never auto-merged. | Laundering an untrusted request through child issues |
| **Test gate** | Source changed with no test file changed: escalate. Docs-only changes pass. | Untested behaviour changes |
| **Caps** | Loop cap 3, budget $5 or 3M tokens, diff cap 300 lines, CI-fix cap 2 (in `SKILL.md`), post-merge watch of 20 min. | Runaway loops and cost, and oversized auto-merges |
| **Headless runs** | `F headless-args` pins `claude -p` flags: `--output-format json`, `--permission-prompts none`, `auto` mode only with `--write` (build), otherwise `manual` with a read-only allowlist, `--json-schema` for reviews, `--setting-sources user` and `--strict-mcp-config` (no repo hooks or MCP), no `--bare` (it would skip the skill being run), and `--max-budget-usd` from the run's remaining budget. It refuses imported runs and a spent budget. A missing `structured_output` is a failed review. | Unattended runs drifting with `-p` defaults, repo-supplied hooks or MCP servers running untrusted, and runaway cost |
| **Imported runs** | `sync` imports are tracked only: `decide()` always escalates them, and the skill never builds, pushes or merges them. | The factory taking over a human's or another agent's PR |
| **Rules are stricter-only** | A closed set (`ci`, `checks.commands`, `diffCap`), each with a reason, the `gh` login that set it, and an optional expiry. CI that isn't required is never green: `decide()` then needs `F checks` passing on the reviewed commit, with the current command list, or it escalates. See [§5.2](#52-rules). | A rule, or the model, quietly turning CI off |
| **Merge-exact-commit** | `--match-head-commit reviewedSha` | Merging code that was not reviewed |
| **Revert never merges** | `F revert` opens a PR labelled `factory:needs-human` | Automated rollback chains |
| **Shell safety** | Payloads go through stdin (`-`) in a quoted heredoc, and `gh`/`git` run via `execFileSync` with arguments, never a shell string. | Shell injection from issue titles and bodies |
| **Session privacy** | `sessionsByBranch()` reads only branch names, the first `cwd`, session ids and file mtimes, never prompt text; the self-test asserts it. | Leaking prompts into the log or the dashboard |

### 5.1 Runners

Each step can be run by the built-in brief, a user skill or brief, or a harness tool. `F skills <owner/repo>` prints the resolved plan:

```json
{"default": {"review.code": {"use": "skill", "name": "house-review"}},
 "acme/app": {"spec": {"use": "skill", "name": "my-planner"},
              "build": {"use": "provider", "harness": "codex"},
              "review.ui": {"use": "skill", "name": "brand-review"},
              "review.security": {"use": "provider", "harness": "claude-code", "name": "security-review"},
              "verifier": {"use": "provider", "harness": "claude-code", "name": "pr-review-toolkit:code-reviewer"},
              "axes.extra": [{"axis": "a11y", "when": ["**/*.tsx"], "use": "brief", "path": "~/.claude/factory/briefs/a11y.md"}]}}
```

- **Steps:** `intake`, `spec`, `build`, `review.code|security|ux|ui|seo|docs`, `verifier`, `postmerge` and `axes.extra`. A project's step wins over `default`; extra axes from both are combined, and the project's entry wins for the same axis name.
- **Runners:** `default`, `skill` (a name like `x` or `plugin:x`), `brief` (an absolute or `~/` `.md` path) and `provider` (`harness` is `claude-code` or `codex`). Unknown fields, unknown steps, names outside `[\w.-]` and extra axes that reuse a built-in name are refused.
- **What can't be configured.** There is no runner that turns an axis off. `code` and `security` are always selected, and extra axes only add. Runners never reach `gate`, `decide`, `merge`, the caps, `TRUSTED` or `SENSITIVE`. Only the policy rules in [§5.2](#52-rules) reach `decide`, and only to make it stricter or to swap CI for local checks.
- **Contract.** Every reviewer's reply goes through `F review`, which requires a JSON object for the requested axis that passes `validateReview`. Anything else (prose, another axis, unknown fields, a `failed` verdict with no blocking finding) is recorded as a failed review with a high "reviewer output invalid" finding, so it loops back and, at the cap, escalates. A prose provider such as `/code-review` goes through the adapter brief in `references/reviewers.md` first.
- **User-local only.** There is no in-repo `.factory/skills.json`. Even read from the base branch, one merged PR could change the reviewers and the verifier for every later run. Config is a per-user choice, like `automerge`. The catalog does offer a project's own `.claude/skills`. Picking one lets the repo supply that reviewer's content, and a PR that edits it touches `.claude/` (`SENSITIVE`), so that PR never auto-merges.
- **Catalog.** `F skills catalog` and the dashboard read:
  - the factory default;
  - the Claude Code built-ins `code-review` and `security-review` (there is no file to read, so this list is hard-coded);
  - `codex exec` and `codex review` when `codex` is on `PATH`;
  - `~/.claude/skills` and the synced skills, named `anthropic-skills:<name>`;
  - `~/.agents/skills`, which run as a brief;
  - user-scope and synced plugins (skills and commands run as skills, agents as `provider: claude-code`);
  - the attached clone's `.claude/skills` and its project-scope plugins;
  - `~/.claude/factory/briefs/*.md`.

  Each descriptor comes from a file's front matter and is display-only. Every offered runner passes `checkRunner`, and the self-test asserts it. The scan runs once per process. MCP tools, and skills that exist only inside a running session, are not on disk; the picker's "A skill by name" field covers them.
- **`F ui`.** The dashboard served on `127.0.0.1`, with a random token in the printed URL:
  - `GET /` needs the token;
  - `POST /skills` needs the token header, a same-origin `Origin`, a JSON content type and an exact `Host` (against DNS rebinding);
  - it sends no CORS headers, caps the body at 64 KB, and sets `no-store`, `no-referrer` and `DENY` framing;
  - every write goes through `setSkill`, which validates before writing;
  - the token is only in the served response, never in the `dashboard.html` that `render()` writes.

  The written file shows the same Skills sheet read-only, and offers each change as a copyable `F skills set` command. The page's 10-second reload pauses while a dialog is open.
- **Stamped only from the CLI.** `F event`, `F review` and `F gate` stamp the runner. In-process records such as `sync` imports never do, so a tracked human PR never shows a `codex` chip. The verifier's runner is stamped on every `gate` event while it is configured, even in an iteration with nothing to verify.
- **Resolved per event.** The plan is read at each event, not frozen per run, so a config change mid-run applies from the next step.
- **Not recorded.** `postmerge` runners leave no event of their own. They can only add a reason to `F revert`, which never merges.

### 5.2 Rules

`F rules <owner/repo>` resolves the rules from `skills.json`: the project's entry wins key by key over `default`, an entry past its `until` day stops applying (the global one, then the built-in, takes over) and is listed under `expired` with a warning, and one ending within 3 days warns too.

| Key | Values | Enforced in |
|---|---|---|
| `ci` | `required` (built-in), `advisory`, `skip` | `facts()` doesn't read CI under `skip`. `decide()` treats `advisory` and `skip` as "not required", never as green: it needs `r.localChecks` with `state: pass`, `sha == reviewedSha` and the same command list as the rule, else it escalates. With no `checks.commands` rule there's nothing to stand in, so it escalates. `postmerge()` returns `skipped` under `skip` and flags `advisory`, so a billing-red main never opens revert PRs. |
| `checks.commands` | 1–10 one-line commands | `F checks <run>` runs them with `/bin/sh -c` in the run's worktree, with `CI=1` and a 30-minute timeout each, on a clean HEAD (a dirty tree is refused). Output goes to `local-checks.log`; only exit codes reach the log. Setting the key also makes local checks required when CI is required. |
| `diffCap` | `1`–`300` | `decide()` uses `min(300, diffCap)`. Raising the cap isn't possible. |
| `deploy.preview` | `off` (built-in), `advisory`, `required` | `facts()` asks the ship harness for the reviewed commit's deploys and records them. `decide()` under `required` needs one with `kind: web-deploy`, `env: preview`, `state: ready`, an https `url` and `sha == reviewedSha`, from any connector; otherwise it escalates. `advisory` adds a note. Without `packages/ship`, `required` escalates. |

- **Who and why.** `rules set` needs `--reason` and takes `setBy` from `gh api user`, never from an argument. `F skills set` refuses the `rules` and `guide` keys, and a hand-edited entry without a reason, login or valid date fails validation on every read. `render()` catches that and shows a warning chip, so recording events never fails half-way.
- **Audit.** Every `set` and `unset` appends a `rules` event (§3.1). `F event` refuses that stage.
- **Guidance.** `guide.<step>` is free text (`*`, a step key, or `review.<extra axis>`, at most 1000 characters). `F skills` and `F rules` return it per step, whole-flow text first and global before project, and `SKILL.md` puts it in that step's brief, before any repo or issue text. It is user-local, so trusted, and no mechanical check reads it.
- **Not configurable.** `TRUSTED`, `SENSITIVE`, the `code` and `security` axes, `--match-head-commit`, imported runs escalating, the owned events and the typed fields. An unknown key is refused with that list.
- **Not built.** There is no in-repo `.factory/` rules file, for the same reason as runners (§5.1), and no `autoMerge` rule: `F automerge` already covers it.

---

## 6. Onboarding flow

**The setup wizard.** `F ui` opens a full-screen stepper on the dashboard (by itself when no project is attached, otherwise from **Set up**): Local AI → Repo → What you ship → Workflow → Rules → Review and start. Its state comes from `POST /onboard`, and every write goes through `/onboard/{sync,ship,rule,automerge}` or `/skills`, with the same token, Host, Origin and content-type checks and the same validated functions as the CLI (`sync`, `setShip`, `setRule`/`unsetRule`, `setAutoMerge`, `setSkill`). Its position is kept in localStorage, so it resumes. Opened as a static file, it is read-only and shows the command for each step. `F onboard` prints the same steps in the terminal; `F onboard ship <scope> web,mobile,database` stores the ship choice in `onboard.json`.

**AI harnesses are pluggable.** The core never names a harness for behaviour: runner validation, the catalog's provider tools, session import, the event's `harness`/`sessionId` stamp, extra sensitive config folders and the pinned `F headless-args` flags (from the `host` harness, `claude-code.mjs`) all come from `harnesses/*.mjs` (contract and recipe: `packages/factory/HARNESSES.md`). `models()` is reserved in the contract for per-step model selection. The wizard's ship step lists `packages/ship`'s connectors from its own registry; "Create from an idea" turns on once `F new` exists and records the idea through `POST /idea`.

```mermaid
flowchart LR
  D["F discover<br/>scan ~/Development, ~/code, … up to 5 deep<br/>read .git/config → GitHub origins"] --> P{"pick repo + clone"}
  P --> S["F sync owner/repo clone-path"]
  S --> S1["register in projects.json"]
  S --> S2["import each open PR as a run<br/>source: claude-code / codex / none, by branch"]
  S --> S3["import recent agent sessions on unmerged<br/>local branches without a PR, run id owner/repo:branch"]
  S --> S4["close runs whose PR or branch finished elsewhere"]
  S --> S5["write sessions.json links, up to 5 per run"]
  S1 & S2 & S3 & S4 & S5 --> DB["dashboard: per-project filter<br/>Copy resume → claude --resume id / codex resume id"]
```

1. **`F discover [roots…]`** walks the default roots (`~/Development`, `~/code`, `~/projects`, `~/src`, `~/repos`, `~/GitHub`…), skipping hidden folders, `node_modules`, `Library` and build output. It lists one entry per GitHub repo: the preferred clone (the attached one, else the most recently committed), the other clones, the last commit, the worktree count, and whether it is attached.
2. **`F sync owner/repo <clone>`** attaches the repo and imports work already in flight:
   - **Agent sessions are matched by branch,** through each harness adapter's `sessions()` (`harnesses/*.mjs`). Claude Code's come from `~/.claude/projects/<encoded clone path>*/*.jsonl` (`gitBranch`); Codex's from `~/.codex/sessions/**.jsonl` (first-line `session_meta.git`).
   - **Open PRs** become runs with `intake started/passed` (imported), then `build started/passed` with the PR and branch.
   - **Session-only branches** are imported if they are unmerged, local, have no PR, have been active in the last 14 days, and are not `factory/*`. When such a branch later gets a PR, the PR is attached to the same run.
   - **Runs finished elsewhere** are recorded as `approve closed`: a PR merged or closed outside the factory, or a session branch that was merged or deleted.
   - **Re-syncing is idempotent.** `F sync` with no arguments re-syncs every attached project.
3. **The dashboard** now shows the imported runs with their source chip and session links. Copy resume reopens the agent session that was working on that branch.

---

## 7. User flows

### 7.1 Factory an issue

> "factory acme/shop#43"

1. **Intake.** `F intake` returns the issue. Claude reads the repo rules (`CLAUDE.md`, `AGENTS.md`, `REVIEW.md`, `SECURITY.md`, `CONTRIBUTING.md`), checks for duplicates, and decides **pass**.
2. **Spec.** Claude writes `spec.md`. `F risk` says it is not risky, so it records `spec passed`.
3. **Build.** `F worktree`, then `F deps`, then implement, run the tests, write `checks.json`, push, open a draft PR, and wait for CI.
4. **Review.** `F axes` selects `code, security, ux, ui, seo`, and five reviewers run in parallel. In the demo, **ux** finds that the spec never says what happens for an already-subscribed email (route `spec`). The gate loops back to spec, which is iteration 2. Then **security** finds missing server-side validation (route `build`), and the verifier dismisses a second SSRF finding. The gate loops back to build, which is iteration 3. Now every axis passes.
5. **Approve.** `F merge` finds a trusted author, green CI, a 90-line diff and changed tests, and squash-merges the reviewed SHA.
6. **Watch.** In the demo, `F postmerge` reports red on main, so `F revert` opens revert PR #93 for a human.

### 7.2 Dry-run intake

> "factory acme/shop#50 --dry-run --intake-only"

Claude records the intake decision, makes no GitHub writes and creates no worktree. `F eval` uses the same mode against `evals/golden/*.json`, with `FACTORY_FIXTURES` serving the issues offline, and prints a score such as `7/8`.

### 7.3 Attach a repo

> "attach acme/app to the factory"

Claude runs `F discover`, confirms which clone to use, then runs `F sync acme/app ~/code/app`. See [§6](#6-onboarding-flow).

### 7.4 next / triage / sweep

- **`next acme/app`** takes the first entry of `F queue acme/app` `.ready`: an issue a human labelled `factory:ready` that is not yet in the log and whose `Depends on #N` issues are merged or closed. It builds that issue. This is meant for a `/schedule` routine.
- **`triage acme/app`** runs intake only on the first 5 `.untriaged` issues: open, not in the log, and with no `factory:*` label.
- **`sweep acme/app dead-code|coverage`** opens up to 3 **unlabelled** issues whose bodies start "Opened by the software factory sweep". A human decides which ones get `factory:ready`.

### 7.5 Approve a risky spec

An outside contributor's issue #49, "Add Stripe checkout", passes intake, but `F risk` reports:

- `author association "CONTRIBUTOR" is not trusted`;
- `plans to touch sensitive paths: lib/payments/checkout.ts`.

Claude posts the spec as an issue comment, adds `factory:needs-approval`, records `spec awaiting-approval`, and stops. Later, a maintainer comments `/factory approve`. On resume, `F approval` returns `{"decision":"approve","by":"<login>"}`, counting only trusted comments posted after the wait started. Claude records `spec passed {"approvedBy":…}` and builds. The final merge decision still escalates, because of the sensitive path.

### 7.6 Revert

When `F postmerge` returns `state: "fail"` within the 20-minute watch:

1. `F revert RUN "<which check failed>"` creates a temporary worktree from `origin/<base>`.
2. It runs `git revert --no-edit <merge sha>` and pushes `factory/revert-N`.
3. It opens a PR labelled `factory:needs-human` and records `approve reverted`.

It never merges the revert.

### 7.7 Start from an idea

> "factory new: a personal budget app"

Claude asks at most 5 questions (with defaults), then writes `PLAN.md` and `issues.json`; `F` only validates and executes them. Every step is an event on the run `owner/repo:project` (`idea started`, `plan passed`, `repo created`, `issues created`, `loop running|stopped`), all emitted by `F` itself: `F event` refuses them, and `derive()` skips them so they never appear as issue runs.

1. `F new "<idea>" --name o/r --stack next-web --dry-run` → `needs-plan`, then `dry-run` once both files validate (it writes `PLAN.md`, `issues.json`, `scaffold/` and `dry-run.json` to `--out`; see `packages/factory/examples/budget-app/`).
2. **Checkpoint 1.** The user approves the name, visibility (private by default) and stack, then `F new … --yes --path <dir>`: host login check first (never creates an account), create the repo (refusing one it did not create), run the template's init, commit, push `main` once, and set `checks.commands` from the template.
3. **Checkpoint 2.** `F issues create o/r issues.json` previews the batch in dependency order with the issues that will escalate; `--yes` creates it, idempotent by key (a local map plus a hidden key marker in each issue body), with `Depends on #N` lines and an epic.
4. `F sync`, then `F loop o/r` hands out one `owner/repo#N` at a time to the unchanged stages 0–7, with a `/goal` condition built from the template's checks. It stops on the first run a human must resolve, the project budget (`project.budgetUsd`, at most $50), the per-session cap (`project.maxIssuesPerSession`, at most 10) or an empty queue. `factory continue o/r` resumes with `F project` and `F loop`.

Hosts, trackers and stacks are one file each (see their `README.md`), checked by a shared contract in the self-test. **Follow-up:** per-issue intake, comments and labels still call `gh` directly; moving them onto the tracker adapter is not done.

---

## 8. CLI examples

The outputs below are real, generated from the demo fixtures in a throwaway state folder. `F` stands for `node packages/factory/factory.mjs`.

```bash
export FACTORY_DIR=$(mktemp -d)          # never touch the real ~/.claude/factory
F demo                                   # writes 11 sample runs covering most outcomes, one under a ci=skip rule
# → $FACTORY_DIR/dashboard.html
```

**Derived state of the run that looped twice, merged, then was reverted** (`F state 'acme/shop#43'`, trimmed):

```json
{
  "id": "acme/shop#43",
  "outcome": "merged",
  "iteration": 3,
  "loopbacks": [
    { "iteration": 1, "route": "spec",  "reasons": ["ux: 1 blocking finding(s)"] },
    { "iteration": 2, "route": "build", "reasons": ["security: 1 blocking finding(s)"] }
  ],
  "decision": { "action": "merge", "reasons": ["trusted author, all axes passed, CI green, tests changed, 90-line diff, no sensitive paths"] },
  "reverted": { "pr": "https://github.com/acme/shop/pull/93", "reason": "main CI: e2e footer test failed after merge" },
  "tokens": 93000,
  "costUsd": 0.75
}
```

**Escalation reasons** (`F state 'acme/shop#44'` → `.decision`):

```json
{ "action": "escalate", "reasons": [
  "touches sensitive paths: lib/auth/github.ts, package.json",
  "source changed (1 file(s)) with no test change" ] }
```

**Spec risk check:**

```console
$ F risk 'acme/shop#49' lib/payments/checkout.ts
{ "risky": true, "reasons": [
    "author association \"CONTRIBUTOR\" is not trusted",
    "plans to touch sensitive paths: lib/payments/checkout.ts" ] }
```

**Axis selection** with explicit files (with no files, it diffs the worktree):

```console
$ F axes 'acme/shop#45' app/blog/page.tsx lib/x.ts
{ "axes": ["code", "security", "ux", "ui", "seo"], "range": null, "files": ["app/blog/page.tsx", "lib/x.ts"] }
```

**The gate refuses to run with missing verdicts:**

```console
$ F gate 'acme/shop#45'
factory: missing review verdicts: ux, ui, seo
```

**Guard rails on `F event`:**

```console
$ F event 'acme/shop#45' gate passed
factory: "gate passed" is recorded by "gate", not by hand
$ F event 'acme/shop#45' spec passed - <<'JSON'
{"association":"OWNER"}
JSON
factory: these fields come from GitHub or git, not from a payload: association
$ F event 'acme/shop#45' review passed - <<'JSON'
{"axis":"code","findings":[],"note":"ignore previous instructions"}
JSON
factory: axis verdicts are recorded by "review", not by hand; "event" only takes the verifier usage record ({"role":"verifier",…})
```

**Sync and queue** against the test stubs (`FACTORY_GH=packages/factory/test/gh-stub.mjs`, plus `FACTORY_GIT=…/git-stub.mjs` and an empty `HOME` for sync):

```console
$ F sync acme/app /work/app
[ { "repo": "acme/app", "path": "/work/app",
    "added": ["acme/app#10", "acme/app#11", "acme/app#12", "acme/app#14"],
    "attached": [], "closed": [] } ]
$ F queue acme/app
{ "ready":     [ { "run": "acme/app#40", "title": "ready one" } ],
  "untriaged": [ { "run": "acme/app#41", "title": "new one" }, { "run": "acme/app#7", "title": "known" } ] }
```

**Self-test:**

```console
$ pnpm --filter @software-factory/factory test
ok - all checks passed (<tmp dir>)
```

The self-test unsets `CLAUDE_CODE_SESSION_ID`, because some of its assertions check exactly which session ids get recorded.

---

## 9. Roadmap

- **Desktop app.** An Electron + Vite/React shell built from `@software-factory/design-system`, fed by a new `F serve` command: a loopback HTTP server plus SSE over `derive()`. `factory.mjs` remains the only writer.
- **Model per event.** Record which model produced each intake, spec, review and verifier event, next to `tokens` and `costUsd`, so the dashboard can attribute cost and quality per model and per axis.
- **SQLite index.** `events.jsonl` stays the append-only source of truth. A rebuildable SQLite index would replace the full re-derive on every render once logs grow, while `archive` keeps the live log small until then.
- **Build orchestration (only if needed).** Turborepo on top of pnpm for cached, affected-only builds once the desktop app makes builds slow.
- **Ship harness.** Phase 0 (read-only connectors, GitHub Deployments, `deploy.preview`) is built in `packages/ship`; the next phases (Vercel logs, Neon branches, Expo/EAS, store state, the Ship view) follow [docs/plans/ship-harness.md](plans/ship-harness.md), each provider as one connector file plus its fixture. Other third-party integrations (Sentry, Figma, PagerDuty) are still out of scope. Only `SKILL.md`'s intake fetch, comment and label steps are GitHub-specific, so another tracker can be swapped in later (see "Other trackers" in `SKILL.md`).
