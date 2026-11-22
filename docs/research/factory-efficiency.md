# Software factory: efficiency research (storage, speed, tokens)

As of 2026-11-22. This is a companion to [ai-engineering-flows.md](ai-engineering-flows.md), covering how to make each factory run cheap in disk, wall-clock time and tokens.

Scope: the current pipeline only (intake → spec → build → review → gate → approve), with no third-party services. Every recommendation below names the place in `SKILL.md` or `factory.mjs` it changes.

## TL;DR: ranked by value against effort

| # | Change | Saves | Effort |
|---|---|---|---|
| 1 | **Worktree per run, removed by `F` when the run reaches an outcome**, plus an `F gc` sweep for orphaned worktrees | Disk; never blocks your checkout; parallel runs | Low |
| 2 | **Dependencies linked, not reinstalled**: pnpm's shared store, or an APFS clone of `node_modules` when the lockfile is unchanged | Disk (most of it) and minutes per run | Low |
| 3 | **On loop-back, re-run only the failed review axes**, plus code review on the incremental diff | Tokens: roughly 40–80% of review spend on iterations 2–3 | Low |
| 4 | **Run checks once in Build and write them to `DIR/checks.json`**; reviewers read results instead of each re-running the test suite | Time, CPU contention, tokens | Low |
| 5 | **Model routing per stage**: a cheaper model for intake triage, SEO/UI axes and verifiers; the strongest model only for spec, build and code/security | Tokens and $ | Low |
| 6 | **Changed-tests-first in the build loop** (`vitest --changed`, `jest --changedSince`); full suite once before push | Wall-clock per iteration | Low |
| 7 | **Record tokens, cost and duration per stage on events** (it's how you find the next cut) | Visibility | Low |
| 8 | **Stable prompt prefixes** for reviewer briefs, so prompt caching hits | Tokens (cache reads are billed at 0.1× input) | Low |
| 9 | **Archive finished runs out of `events.jsonl`** so `render()` doesn't re-derive history on every event | CPU and disk as runs accumulate | Low |

---

## 1. Storage: worktree lifecycle

**Today:** Setup demands a clean `git status` in the user's clone, then switches branches in place (`SKILL.md` §0 and §3). Only one run at a time is possible, and it disturbs your checkout.

**Proposal:**

- **Create:** `git worktree add <FACTORY>/wt/<run-slug> -b factory/issue-N origin/BASE`. Worktrees share the repo's object store, so no second clone is made ([git-worktree docs](https://git-scm.com/docs/git-worktree)). Put it under `runDir()`'s parent, never inside the repo.
- **Remove mechanically, inside `record()`:** when an event's status is an outcome (`rejected`, `needs-info`, `merged`, `escalated`), and also on `build failed`, run:
  1. `git worktree remove --force <path>`;
  2. `git worktree prune`;
  3. `git branch -D factory/issue-N` locally.

  The branch is already pushed, so an escalated PR loses nothing: a resume recreates the worktree from `origin/factory/issue-N`.

  Put this in `F`, not in prose. The agent will forget the prose; it can't skip the code. `--force` is needed because removal refuses dirty or untracked trees ([git-worktree docs](https://git-scm.com/docs/git-worktree)).
- **`F gc`:** list `git worktree list --porcelain`. Remove any factory worktree whose run has an outcome or has had no event for more than N hours (crashed sessions), then prune. Run it at the start of every factory invocation. That costs nothing and keeps the folder bounded.
- **Keep artifacts outside the worktree:** `spec.md` and the events already live in `DIR`, so deleting the worktree loses no history.
- **Don't rely on Claude Code's own worktree cleanup.** The `WorktreeRemove` hook only fires for hook-created worktrees, and adopted worktrees may not be cleaned on exit ([issue: WorktreeRemove for git worktrees](https://claudeissues.com/issue/94212-feature-fire-worktreeremove-or-a-notification-event-when-claude-code-removes-a-g), [issue: cleanup of adopted worktrees](https://claudeissues.com/issue/92425-docs-worktrees-exit-time-cleanup-of-an-adopted-worktree-opened-by-name-not-creat)). Owning the lifecycle in `factory.mjs` avoids that.

## 2. Dependencies: link, don't recreate

`node_modules` is most of the disk use and install time in a fresh worktree. Pick the strategy from the lockfile in the repo:

| Repo uses | Strategy | Why it's cheap | Source |
|---|---|---|---|
| **pnpm** | `pnpm install --frozen-lockfile --prefer-offline` in the worktree | One global content-addressable store, hard-linked (or reflinked) into each `node_modules`. A 1 MB package costs 1 MB total however many worktrees use it, and `--prefer-offline` skips registry staleness checks. | [pnpm motivation](https://pnpm.io/motivation), [pnpm FAQ](https://pnpm.io/faq), [pnpm install](https://pnpm.io/cli/install) |
| **npm / yarn, lockfile identical to the main checkout** | `cp -cR <main>/node_modules <wt>/` (an APFS clone) | A copy-on-write clone shares disk blocks: near-instant, no extra space until a file changes, and changes diverge safely. Same APFS volume only. | [ctrl.blog: file cloning](https://www.ctrl.blog/file-cloning.html), [Apple: APFS cloning](https://developer.apple.com/library/archive/samplecode/APFSCloning/Introduction/Intro.html) |
| **npm / yarn, lockfile changed** | `npm ci --prefer-offline` (or `yarn install --immutable`) | Uses the local npm cache and skips online checks for cached packages. | [npm ci docs](https://docs.npmjs.com/cli/v11/commands/npm-ci), [GitLab caching example](https://gitlab.com/gitlab-org/gitlab/-/merge_requests/25758) |

**Rules:**

- **Decide by lockfile hash.** If `sha256(lockfile)` in the worktree matches main's and main's `node_modules` exists, clone it; otherwise install. If the run changes the lockfile, it's a sensitive path and escalates anyway (`SENSITIVE` already covers manifests).
- **Don't symlink `node_modules`** from the worktree to the main checkout. Node resolves modules by realpath, which breaks hoisting assumptions and some bundlers and test runners. Any install in the worktree would also mutate your main checkout. pnpm itself avoids symlinking into the store for this reason: it would need `--preserve-symlinks` ([pnpm FAQ](https://pnpm.io/faq)). Clones give the same speed without the shared mutable state.
- **The same trick works for build caches** (`.next/cache`, `.turbo`, `node_modules/.vite`): `cp -cR` them from main when present. This is optional, but it shortens the first build in each worktree.
- **Store location:** keep the factory worktrees on the same volume as the repo and the pnpm store. Hard links and clones don't cross filesystems; across volumes, pnpm silently falls back to copying ([pnpm FAQ](https://pnpm.io/faq)).
- **Implement it as one `F deps <run>` command** that picks the strategy and prints what it did. Build calls it right after creating the worktree.

## 3. Performance: less repeated work per iteration

| Today | Change | Where |
|---|---|---|
| Build runs lint, typecheck, tests and build. Then the code reviewer runs the test command again, and parallel reviewers may run tools at the same time in one tree. | Build writes `DIR/checks.json` (each command, its exit code, and the last 50 lines on failure). Reviewers read it and run nothing heavy. Only the code axis may run a targeted test to prove a finding. | `SKILL.md` §3, `reviewers.md` (code) |
| Every iteration runs the full test suite while the build loops. | While iterating, run only the tests touched by the change: `vitest --changed origin/BASE` / `jest --changedSince=origin/BASE`. Run the full suite once before the push. | `SKILL.md` §3 ([Vitest CLI](https://vitest.dev/guide/cli), [Jest CLI](https://jestjs.io/docs/cli#--changedsince)) |
| Review runs before CI results are known. | Wait for CI after Build. A red build goes straight back to build, which is cheaper than paying for a full review first. | `SKILL.md` §4–§6 |
| In monorepos, the whole repo is built and tested. | If the repo has Nx or Turborepo, use `nx affected` / `turbo --filter=...[origin/BASE]`. Running only affected projects is the largest CI lever ([Nx affected](https://nx.dev/docs/features/ci-features/affected)). | `SKILL.md` §3 |
| `render()` re-reads and re-derives *all* events on every `F` call. | Move each finished run's events to `archive/<run>.jsonl`, and keep a one-line summary per run for the dashboard's history table. The work per call then stays proportional to active runs. | `factory.mjs` `record()`/`render()` |

## 4. Token consumption

Most factory spend is the build session plus 2–5 parallel reviewers per iteration, multiplied by up to 3 iterations.

| Lever | Change | Why | Source |
|---|---|---|---|
| **Re-review only what changed** | On a loop-back, re-run only the axes that failed, plus `code` on `git diff <last-reviewed-sha>..HEAD`. A passed axis re-runs only if the new diff touches files in its scope (`axesFor` on the incremental diff). Record `reviewed_sha` on the `review started` event. | With 5 axes and one failing, iteration 2 costs about 2 reviews instead of 5. | n/a: follows from the pipeline design |
| **Model per stage** | Use the Agent tool's `model` option: a cheaper model for intake triage, the SEO and UI axes, and the finding verifier. Keep the strongest model for spec, build, code and security. | Subagents are a large share of the tokens; small-model routing is the standard cost lever. | [Claude Code costs](https://code.claude.com/docs/en/costs) |
| **Small, isolated contexts** | Reviewers already get only the brief, the spec path, the repo and the base branch (good). Also pass `git diff --stat` and tell them to read only the changed files plus their direct imports, not to explore. Cap each reviewer's reply to the JSON, which is already done. | The attention budget is finite; subagents should return condensed results. | [Anthropic: Effective context engineering](https://anthropic.com/engineering/effective-context-engineering-for-ai-agents) |
| **Cache-friendly prompts** | Put the static axis brief and the output schema first, and the run-specific paths last, worded identically every time. | Cached prefix reads are billed at 0.1× input; a 5-minute cache write costs 1.25×, so it pays off after one hit. | [Prompt caching docs](https://docs.claude.com/en/docs/build-with-claude/prompt-caching) |
| **Don't re-read the issue body every stage** | After intake, stages read `spec.md` only. The issue body is needed again only on a `route: spec` loop-back. | It cuts repeated input and also limits exposure to untrusted text. | n/a: follows from the pipeline design |
| **Lean main context** | The orchestrator should not `cat` large logs. Pipe test output through `tail -50`, and `--json` gh output through `--jq` to the needed fields. | Tool output stays in the context and is re-sent on every later turn. | [Claude Code costs](https://code.claude.com/docs/en/costs) |
| **Cheap early exits** | Run intake reject and needs-info on the cheap model. Most junk issues end there. | Avoids paying for a spec on an issue that gets rejected. | n/a |
| **Measure** | Record `tokens_in`, `tokens_out`, `cost_usd` and `duration_ms` on each stage's event (from the subagent result usage, or Claude Code's OpenTelemetry `claude_code.cost.usage`). Show cost per run and per stage on the dashboard. | You can't cut what you can't see. | [Claude Code monitoring](https://code.claude.com/docs/en/monitoring-usage) |

## 5. Suggested implementation order

1. Add `F worktree <run>` (create plus deps), outcome-triggered removal in `record()`, and `F gc`. Update `SKILL.md` §0 and §3 to work in the worktree, and drop the "clean `git status`" requirement.
2. Add `checks.json` written by Build. Change the code reviewer brief to read it instead of re-running the suite.
3. Do incremental re-review: add `reviewed_sha` to the event and change `F axes` to take the incremental diff on iteration 2 and later.
4. Add per-stage `model` choices in `SKILL.md` §4 and `reviewers.md`.
5. Add cost and duration fields on events, and a cost column on the dashboard.
6. Archive finished runs out of `events.jsonl`.

Each step can be tested with the existing `test()`/`cliTest()` harness. Worktree removal and `gc` need a temp git repo fixture.

---

**What I didn't check:** I took `vitest --changed` and `jest --changedSince` from their CLI docs and didn't test them here. The APFS clone of `node_modules` is untested against tools that write into `node_modules` in place, such as postinstall scripts and `.cache` folders; verify that on one of your repos first. The 40–80% token saving from incremental review is my estimate from the pipeline's shape, not a measurement.
