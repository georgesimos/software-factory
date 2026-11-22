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
├── .gitignore                node_modules, dist, .nx, .env* (keeps .env.example)
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
│   │   ├── dashboard.html    static dashboard template; F render injects the run data at __FACTORY_DATA__
│   │   ├── references/
│   │   │   └── reviewers.md  per-axis reviewer briefs (code, security, ux, ui, seo, docs) and the verifier brief
│   │   ├── evals/golden/     1.json … 8.json: intake fixtures with the expected outcome (pass / needs-info / reject / split)
│   │   ├── test/
│   │   │   ├── gh-stub.mjs   fake `gh` used by the self-test (FACTORY_GH)
│   │   │   └── git-stub.mjs  fake `git branch --no-merged` used by the sync test (FACTORY_GIT)
│   │   └── package.json      private; `test` = env -u CLAUDE_CODE_SESSION_ID node factory.mjs test
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
    └── playground/           (in progress, not yet committed) Vite playground for the design system (`pnpm dev`)
```

**Monorepo tooling.** The repo uses pnpm workspaces. An Nx package-based setup has been decided but is not wired up yet: there is no `nx.json` and no Nx dependency. Root `pnpm test` runs the contrast check, then `pnpm -r test` across every package, which includes the factory self-test.

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
| Intake | `intake`, `queue` | Fetches the issue from GitHub so title, author and association are never typed by the model. |
| Spec gate | `risk`, `approval` | Untrusted authors and sensitive planned files require `/factory approve`. |
| Build | `worktree`, `deps`, `gc` | One git worktree per run; the cheapest available way to get `node_modules`. |
| Review | `axes` | Picks the review axes from the diff and records the reviewed commit SHA. |
| Decisions | `gate`, `decide`, `merge` | Pure functions over derived state plus live GitHub facts. |
| After merge | `postmerge`, `revert` | Watches CI on the merge commit; opens a revert PR, never merges it. |
| Onboarding | `discover`, `sync`, `projects`, `automerge` | Finds local clones, imports open PRs and agent sessions. |
| Housekeeping | `archive`, `render`, `demo`, `test`, `eval` | `eval` runs headless `claude -p` over the golden fixtures and costs tokens. |

Environment overrides:

- `FACTORY_DIR`: the state folder. The default is `~/.claude/factory`.
- `FACTORY_GH` and `FACTORY_GIT`: stubs, used by the self-test only.
- `FACTORY_FIXTURES`: offline eval issues.

### 2.3 The event log

The log is an append-only JSONL file, and it is the source of truth. Everything else is derived from it or is a cache. See [§3](#3-data-model).

### 2.4 The dashboard

`dashboard.html` is a self-contained static page. On every `record()`, `F render`:

1. derives all runs, live and archived;
2. merges in the session links from `sessions.json`;
3. computes metrics overall and per project: merge rate, average iterations, median cycle time, revert rate, cost per merge;
4. writes `~/.claude/factory/dashboard.html` with the data inlined as JSON.

`<` is escaped as `<`, so issue titles cannot break out of the script tag; the self-test asserts this. The page filters by project, and each run's detail has Pipeline, Review, Decision, Loop-backs, Sessions and Timeline sections; a split parent also gets an Epic section listing its children. For each linked agent session it offers a **Copy resume** button, which copies `cd '<cwd>' && claude --resume <id>` for Claude Code or `codex resume <id>` for Codex. Ids that don't match `[\w.-]+` get no button.

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
- **`stage`** is one of `intake | spec | build | review | gate | approve`.
- **`status`** is one of `started | passed | failed | decided | reverted`, or one of the outcomes `rejected | needs-info | merged | escalated | closed | awaiting-approval | split`.
- **The payload** is spread into the event: for example `summary`, `spec`, `pr`, `branch`, `axes`, `sha`, `range`, `axis`, `findings`, `reasons`, `next`, `action`, `facts`, `tokens` and `costUsd`.
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
| `reviews[iteration][axis]` | `{verdict, findings}`. The **verdict is recomputed from the findings**: any undismissed high or medium finding means `failed`, whatever the reviewer wrote. |
| `loopbacks[]` | `gate` events whose `next` is `spec` or `build` |
| `decision` | the last `approve decided` |
| `outcome` | the last outcome status. It resets to `in-progress` on a new `intake started` (a resume after needs-info), and leaves `awaiting-approval` on the next non-outcome event. |
| `reverted` | `{pr, reason}` from `approve reverted` |
| `costUsd`, `tokens` | summed from every event that reports them |
| `sessions[]` | distinct `sessionId`s with their last-seen time |
| `parent` | set on a split child from the parent's `children` |

`TERMINAL` outcomes are `rejected`, `merged`, `escalated`, `closed` and `split`. `needs-info` and `awaiting-approval` are parked states that resume.

### 3.3 Side files in `~/.claude/factory/`

| File | Written by | Contents |
|---|---|---|
| `projects.json` | `sync`, `worktree`, `automerge` | `{ "owner/repo": { path, synced, autoMerge? } }`, mapping each attached project to its local clone |
| `sessions.json` | `sync` | `{ runId: [ {agent, id, cwd, last} ×≤5 ] }`, linking runs to local Claude Code and Codex sessions by branch |
| `archive.jsonl` | `archive` | one compact run per line (derived state plus its last 5 events, `archived: true`) for finished runs older than N days (default 14) |
| `events.jsonl.bak` | `archive` | the log as it was before the last archive |
| `dashboard.html` | `render`, called after every `record()` | the generated dashboard |

### 3.4 Per-run folder: `runDir = ~/.claude/factory/<run id with non-alphanumerics → "-">`

| Path | Purpose |
|---|---|
| `spec.md` | the spec (Goal, Non-goals, Acceptance criteria, Files, Test plan, Risks, `## Changes` on a loop-back) |
| `checks.json` | `{lint, typecheck, tests, build, notes}`. Reviewers read this instead of re-running the checks. |
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
| **Owned events** | `F event` refuses `intake started` (owned by `intake`), `review started` (`axes`), every `gate` event (`gate`), `approve decided/merged` (`merge`), `approve reverted` (`revert`) and `approve closed` (`sync`). `record()` itself refuses `merged` unless the recorded decision is `merge`. | The model recording its own approval or a merge |
| **Typed fields** | `F event` rejects payloads that carry `association`, `originAssociation`, `origin`, `author`, `sha`, `imported`, `source`, `action`, `harness`, `sessionId` or `cwd`. These only come from GitHub, git or the harness. | Spoofed trust, provenance or session links |
| **Review contract** | `validateReview()` rejects unknown fields, an axis outside this iteration's selection, a severity other than `high`/`medium`/`low`, a route other than `spec`/`build`, an empty `issue`, and a `failed` verdict with no blocking finding. `derive()` recomputes the verdict from the findings. | Reviewer output smuggling text or a misleading verdict |
| **Verifier** | Its dismissals are stored as `dismissed: "<reason>"`. A dismissed finding stays visible but does not block. | False positives blocking the gate, without hiding them |
| **Sensitive paths** | `SENSITIVE` matches auth, login, session, oauth, payments, billing, money and migrations; `.github/workflows/`; package manifests and lockfiles (npm, pnpm, yarn, bun, pip, poetry, Gemfile, Go, Cargo); and `.env*`. `risk` checks them before the build, `decide` after. | Auto-merging changes to security, money, CI or the supply chain |
| **Split inheritance** | A child of a split records its parent's `origin` and `originAssociation`, so an untrusted parent makes the child risky and never auto-merged. | Laundering an untrusted request through child issues |
| **Test gate** | Source changed with no test file changed: escalate. Docs-only changes pass. | Untested behaviour changes |
| **Caps** | Loop cap 3, budget $5 or 3M tokens, diff cap 300 lines, CI-fix cap 2 (in `SKILL.md`), post-merge watch of 20 min. | Runaway loops and cost, and oversized auto-merges |
| **Imported runs** | `sync` imports are tracked only: `decide()` always escalates them, and the skill never builds, pushes or merges them. | The factory taking over a human's or another agent's PR |
| **Merge-exact-commit** | `--match-head-commit reviewedSha` | Merging code that was not reviewed |
| **Revert never merges** | `F revert` opens a PR labelled `factory:needs-human` | Automated rollback chains |
| **Shell safety** | Payloads go through stdin (`-`) in a quoted heredoc, and `gh`/`git` run via `execFileSync` with arguments, never a shell string. | Shell injection from issue titles and bodies |
| **Session privacy** | `sessionsByBranch()` reads only branch names, the first `cwd`, session ids and file mtimes, never prompt text; the self-test asserts it. | Leaking prompts into the log or the dashboard |

---

## 6. Onboarding flow

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
   - **Agent sessions are matched by branch.** Claude Code sessions come from `~/.claude/projects/<encoded clone path>*/*.jsonl` (`gitBranch`). Codex sessions come from `~/.codex/sessions/**.jsonl` (first-line `session_meta.git`).
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

- **`next acme/app`** takes the first entry of `F queue acme/app` `.ready`: an issue a human labelled `factory:ready` that is not yet in the log. It builds that issue. This is meant for a `/schedule` routine.
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

---

## 8. CLI examples

The outputs below are real, generated from the demo fixtures in a throwaway state folder. `F` stands for `node packages/factory/factory.mjs`.

```bash
export FACTORY_DIR=$(mktemp -d)          # never touch the real ~/.claude/factory
F demo                                   # writes 9 sample runs covering most outcomes
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
factory: review payload has unknown fields: note
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
- **Nx wiring.** Add `nx.json` with package-based targets (`build`, `test`, `contrast`) and affected-only CI.
- **License.** TBD (MIT or Apache-2.0) before the repo goes public.
- **Non-goal for now: third-party integrations.** No Sentry, Figma, PagerDuty or similar. Only `SKILL.md`'s intake fetch, comment and label steps are GitHub-specific, so another tracker can be swapped in later (see "Other trackers" in `SKILL.md`).
