# Local-first inventory: every GitHub assumption (origin/main 7f9bbab)

The target is a Windows machine with no GitHub access. The repo is a local git clone, and its origin is any host or none. CI is Jenkins or something else.

This is read-only research: no code changed. Line numbers are from 7f9bbab. "Breaks" means what happens today when `gh` is missing or GitHub can't be reached.

**How gh is invoked.** Everything goes through one stubbable binary:
- `io.gh` reads `FACTORY_GH` (`packages/core/src/log.ts:17`).
- Every `gh(...)` call resolves through it (`github.ts:31`).
- Adapters get `{gh, git}` from `adapterCtx()` (`github.ts:74`).
- The ship connectors call `ctx.exec('gh', …)`.

There is a working offline precedent: `FACTORY_FIXTURES` intake for `eval/golden` (`github.ts:40,68-73`).

---

## 1. Repo identity

| Where | Assumption | Breaks without GitHub | Seam |
|---|---|---|---|
| `core/src/project.ts:44` `REPO`, `:48` `checkRepo` | The owner part is GitHub-login-shaped: 1-39 chars, `[A-Za-z0-9-]`. | Bitbucket workspaces and project keys mostly fit. A repo with no remote has no owner at all. | A project id that need not be owner/name, e.g. `local/<folder>`, or a host adapter's own `checkId`. |
| `server/src/server.ts:165-168` `checkRepo` | The owner must match `rules.LOGIN` (a GitHub login). | The same refusal, at `POST /api/runs` and the clone lookup. | The same project-id seam. |
| `server/src/server.ts:170-177` `parseRun`, `core/src/github.ts:32-36` `parseRun` | A run id is `owner/repo#N`, with N an integer issue number. | Jira keys (`ABC-123`) or a local item id don't fit. Runs and claims are keyed by N. | Run id = `<project>#<item id>`, where the tracker owns the id format. Parse once in core and share it with server.ts. |
| `core/src/sync.ts:90` | "PRs and issues share GitHub's number space": an imported PR's run id reuses its PR number. | An import can collide with an issue run of the same N on other hosts. | Imported change requests get their own namespace, e.g. `owner/repo:cr-17`. |
| `core/src/sync.ts:66` | `sync` takes only `owner/repo`. | Can't attach a clone without a GitHub-shaped name. | Same as REPO. |
| `core/src/sync.ts:48-50` `discover` | The origin URL must match `github.com[:/]owner/name`. | A non-GitHub origin, or no origin, is skipped silently: **"No GitHub clones found"**. | Parse any remote form (scp, ssh, https, file, none), as `codex.mjs:37 slug()` already does. With no remote, use `local/<folder>`. |
| `apps/web/src/Setup.tsx:199`, `design-system/src/onboarding/ProjectPicker.tsx:25,46,58` | Copy: "No GitHub clones found", "with a GitHub remote". | Misleading empty state. | Copy only: "git clones". |
| `core/src/sync.ts:29` `DISCOVER_ROOTS` | Includes `GitHub`. | Harmless. On Windows the roots are joined under the home folder; OneDrive is skipped. | None needed. |
| `core/src/sync.ts:19` | `sessions(repoPath, https://github.com/${repo}.git)`: harness logs are matched by a synthesized GitHub URL. | Codex sessions (`codex.mjs:93-94`, which match on `slug(remote)`) never match a non-GitHub origin. | Pass the clone's real `remote.origin.url`, or `''` when there is none, and fall back to matching by repo path. |
| `core/src/workspace.ts:29` `worktree()` | The base branch comes from `gh repo view --json defaultBranchRef`. | **Every build fails**: no worktree means no run. | `git symbolic-ref refs/remotes/origin/HEAD`, else the `init.defaultBranch` config, else a per-project `base` in projects.json. |
| `core/src/github.ts:169` `revert()` | Same base lookup. | revert fails. | Same. |
| `server/src/server.ts:565` scrub | Removes `github.com/...` URLs before the privacy checks. | Other hosts' URLs stay and may trip the login-in-path refusal, so publishing could be refused. | A host adapter supplies its "public URL" pattern. |
| `server/src/server.ts:576` `SECRET` | Recognizes only GitHub (`ghp_`, `github_pat_`) and Anthropic token shapes. | Bitbucket app passwords and Jenkins API tokens are not caught by the leak check. | Each host and CI adapter contributes its secret patterns. |
| `apps/web/src/RunDetail.tsx:42,273` | "Review and merge on GitHub", and `https://github.com/${repo}/issues/${n}` links. | Dead links on other hosts. | URLs come from the tracker and host adapters (`url` is already on events). |

## 2. Work items (issues)

| Where | Assumption | Breaks | Seam |
|---|---|---|---|
| `core/src/github.ts:38-67` `intake()` | Reads the issue (`gh api repos/R/issues/N`), its comments, and open PRs (GraphQL, `:75-80`). Takes the title, author, association and state from GitHub so they're never model-typed. | **The run can't start**: intake is the first step. | `tracker.getItem(ctx, {repo, id})` returning `{title, url, author, trust, state, body, comments[]}`, plus `host.openChangeRequests()` for the clash check. |
| `adapters/trackers/README.md`, `index.d.mts` | **Already abstracted:** `createIssues`, `listOpen`, `dependencies` (used by `F issues create`, `queue`, `loop`; `project.ts:292,317-330`). | The default tracker is `github-issues` (`project.ts:174,211,292,317`). | Add `getItem`/`comments` to the contract. Add a `local` tracker: a folder of markdown/JSON items in the state dir, or a `ISSUES/` folder in the repo. Jira is a later adapter. |
| `adapters/trackers/github-issues.mjs:21,23,31,42` | Labels (`factory:ready` etc.) via `gh label create`, `gh issue list/create`. | queue/loop/issues create fail. | Covered by the tracker seam. |
| `adapters/trackers/github-issues.mjs:47` | Dependencies are `depends on #N` in the body. | GitHub-specific syntax. | Already the tracker's `dependencies()`. |
| `core/src/github.ts:122-127` `relabelMerged` | Issue labels after a merge, via REST. | Only warns: labels are cosmetic. | `tracker.markDone(ctx, {repo, id})`, a no-op locally. |
| `packages/factory/SKILL.md:61,63,86,93` | The orchestrator itself runs `gh label create`, `gh api …/labels`, `gh issue list` (duplicates), and `gh issue create` (split children). | The model would try gh and fail. | Move each step to an F command backed by the tracker (`F label`, `F split` → `tracker.createIssues`). The skill then never names gh. |

## 3. Change requests and merge

| Where | Assumption | Breaks | Seam |
|---|---|---|---|
| `SKILL.md:139` | Build opens a draft PR: `gh pr create … "Closes #N"`. | No PR, so `decide()` escalates with "no PR recorded" (`gate.ts:85`). | `host.openChangeRequest()`. For a local host, the change request is the pushed (or local) `factory/issue-N` branch plus the reviewed sha, and `r.pr` becomes an optional URL. |
| `core/src/github.ts:82-103` `facts()` | Association (`gh api issues/N`), diff and files (`gh pr view --json additions,deletions,files`), and CI (`gh pr checks`, `:96`). | **`F decide`/`F merge` throw** on the first gh call (`main.ts:132-133`). The run escalates by default, so nothing unsafe happens, but nothing ever merges. | Split it. Diff and files come from git: `git diff --numstat base...reviewedSha`. This is more trustworthy than the host because it measures the exact reviewed commit. Association comes from the tracker's trust. CI comes from a CI adapter (section 5). |
| `core/src/github.ts:105-118` `merge()` | `gh pr ready` + `gh pr merge --squash --delete-branch --match-head-commit <reviewedSha>`. | Merge fails. | `host.merge(ctx, {repo, branch, sha, base})`. The local version: verify the branch head == reviewedSha, squash onto the freshly fetched base in a temp worktree, push with `--force-with-lease=<base>:<seen sha>` (atomic, like `--match-head-commit`), or update the local base ref with no remote. |
| `core/src/github.ts:129-145` `approval()` | Spec approval = a trusted `/factory approve` comment on the issue. | `F approval` throws, so the run waits forever at awaiting-approval. | A tracker comment channel, or a local `F approve RUN` that records an identified human. Design decision: #21 says approval is never taken from the page. |
| `core/src/github.ts:147-160` `postmerge()` | The merge commit from `gh pr view --json mergeCommit`; base CI from `gh run list --commit`. | postmerge fails. | The merge sha is known locally (`host.merge` returns it). CI comes from the CI adapter. |
| `core/src/github.ts:162-183` `revert()` | Base from gh, push, `gh pr create` for the revert PR. | revert fails. | `host.openChangeRequest()` for the revert. The local version leaves a `factory/revert-N` branch and escalates. |
| `core/src/sync.ts:73,115,129-141` sync | Open PRs (GraphQL), PR state, human-merge detection (`gh pr view …mergedBy,mergeCommit,isCrossRepository`). | sync fails, so nothing attaches. | `host.listChangeRequests()` / `host.changeRequestState()`. Locally: `git branch --merged` (misses squash merges; see the shortcut at `sync.ts:97-100`). |
| `SKILL.md:47,184,197-199` | The orchestrator runs `gh pr ready`, labels the PR, and `gh pr comment` on escalation. | Escalation notes go nowhere. | `F escalate RUN` → `host.comment()`. Locally the escalation is the dashboard plus the run's events. |
| `core/src/project.ts:219`, `adapters/hosts/*` | **Already abstracted** for new projects: `authStatus`, `createRepo`, `pushInitial`. | `new` defaults to the `github` host. | Extend this same host contract with the change-request functions above, and add a `local`/plain-git host. |

## 4. Trust and identity

| Where | Assumption | Breaks | Seam |
|---|---|---|---|
| `core/src/constants.ts:30` `TRUSTED` | GitHub `author_association` ∈ OWNER/MEMBER/COLLABORATOR. | No association, so every run is untrusted. That is safe: specs need approval (`gate.ts:101-107`) and merges escalate (`gate.ts:50`). | The tracker returns `trust: 'trusted'|'untrusted'` from its own membership model. The local tracker gets a `trusted-authors` list in the state dir, editable only through F with an audit, like rules. |
| `core/src/github.ts:61,142` | Comment filtering and approval votes use the association. | As above. | Same trust field on comments. |
| `core/src/rules.ts:82-87` `whoami` | `gh api user --jq .login` is the identity behind every rule change and note. | **Rules and notes cannot be saved at all without gh**: `setRule`/`unsetRule` (`rules.ts:96-128`), `F note` (`notes.ts:37`), `POST /onboard/rule` and `/note` (`server.ts:99,109-110`). That blocks the `ci=skip` + `checks.commands` escape hatch itself. | `host.whoami()`. The local version is the OS user (`os.userInfo().username`), or `git config user.email`, plus the machine's state dir. That is weaker than a host-verified login, so record its source. |
| `core/src/rules.ts:34,49` `LOGIN` | `setBy` must be a GitHub-login-shaped string. | `DOMAIN\user` or an email fails `checkRules`, so skills.json won't validate. | Widen it to `{by, via}` (via = host id), with a per-host shape check. |
| `adapters/hosts/github.mjs:5-6` `authStatus` | `gh auth status`, `gh api user`. | `new` refuses to start. | Already a host function. A local host returns `{ok:true, login: OS user}`. |

## 5. CI

| Where | Assumption | Breaks | Seam |
|---|---|---|---|
| `core/src/github.ts:94-101` | `ci` rule: `required` (default) reads `gh pr checks`; `skip` reads nothing. | Default `required` → facts() throws → escalate. | A CI adapter: `ci.checks(ctx, {repo, sha})` → pass/fail/pending/none. Jenkins first (its REST `/job/…/api/json` by commit, or the build-status records it posts to the host). |
| `core/src/gate.ts:58-75` | **Already the stand-in:** `ci=skip|advisory` + `checks.commands` → `F checks` (`workspace.ts:100-123`) runs the commands on the clean reviewed commit and records exit codes. `decide()` accepts a pass only on `reviewedSha` with the same command list. | Works with no host today, except that setting the rule needs `whoami` (section 4). | Fix whoami, and this path works offline end to end. The noted shortcut (`workspace.ts:97-99`: same worktree, user env, ignored files unchecked) matters more when it is the only CI. |
| `core/src/github.ts:154-159` postmerge | Base-branch CI via `gh run list`. | Throws. Under `ci=skip` it returns `skipped` before any gh call, but the `gh pr view` at `:151` runs first and throws. | Merge sha from the host or git; CI from the CI adapter. |
| `SKILL.md:75,141-145` | The orchestrator watches `gh pr checks --watch` and reads `gh run view --log-failed`. | It can't see CI. | `F ci RUN [--watch]` via the CI adapter, returning a log tail. |

## 6. Everything else that shells out to gh

- `adapters/hosts/github.mjs:5,6,9,16,22-27` (host adapter: auth, view, create, push). Already behind the host seam.
- `adapters/trackers/github-issues.mjs:21,23,31,42`. Already behind the tracker seam.
- `ship/connectors/github-deployments.mjs:3,28`: deploy state through `gh api`. Already behind the ship connector seam; it reports "not available", never throws (`ship.ts:32`).
- `core/src/rules.ts:84` whoami (section 4).
- `core/src/workspace.ts:29` base branch (section 1).
- `core/src/github.ts`: every function except `parseRun`, `approvalVote` and `intakeFixture`.
- `core/src/sync.ts:73` (via `openPRs`), `:115`, `:135`, `:139`.
- `SKILL.md`: lines 61, 63, 75, 86, 93, 139-145, 197-199, and 360 (host login), plus 391-393 (sync semantics).
- `apps/desktop/src/login-path.ts:5`: only a comment (gh on the login PATH).
- Tests use `test/gh-stub.mjs` / `gh-project-stub.mjs` through `FACTORY_GH`. A local host/tracker could reuse the same contract tests (`hosts/index.mjs contract()`, `trackers/index.mjs contract()`).

No direct `api.github.com` HTTP calls anywhere: all GitHub traffic goes through the `gh` binary.

---

## Merge preconditions with no host: verifiable locally, or must escalate

From `decide()` (`gate.ts:46-99`). The design rule is that what F can't verify escalates to a human and is never skipped.

**Verifiable locally from git and F's own log, once facts() stops asking GitHub:**
- **Diff size and files** (diffCap, sensitive paths, tests changed). `git diff --numstat base...reviewedSha` is better than the host because it measures exactly the reviewed commit.
- **The reviewed commit is what merges.** The local merge checks `branch head == reviewedSha` and pushes with a lease on the base.
- **Every axis passed on this iteration, the loop cap, the budget, imported-or-not.** These are already log-only.
- **CI.** `ci=skip|advisory` + `checks.commands` with a passing `F checks` on reviewedSha (already implemented). Or a CI adapter that reads Jenkins.
- **auto-merge on/off** (projects.json).

**Cannot be verified without a host or tracker, so these must escalate:**
1. **Author trust** (`gate.ts:50-51`, `risk()` `:103-104`). Nothing local proves who wrote an item. With a local tracker, trust can only come from a local trusted-authors list that F manages. Without one, every run escalates, and every spec needs approval.
2. **Spec approval by a trusted human** (`approval()`). There is no comment channel. Until a local `F approve` with a recorded identity exists, awaiting-approval runs stay escalated.
3. **The item is a real, open work item and isn't a PR** (intake `:50-51`). Needs a tracker. A local tracker answers it for its own items.
4. **Nobody else is already on it** (open change requests that close the issue, `:44-48`). Can't be known locally, so it's advisory at best. The run proceeds, but the merge must re-check whatever the host offers, or escalate if the base moved.
5. **Host-side merge rules** (branch protection, required reviewers, required host checks). Invisible locally. A push may be rejected, and a rejected or unverifiable push must escalate, never retry around it.
6. **`ci=required` with no CI adapter.** "CI green" can't be shown, so escalate (today's behaviour via the throw; should become an explicit reason).
7. **`deploy.preview=required` with no deploy connector.** Already escalates (`gate.ts:93`).
8. **Who changed a rule.** With no host login, `setBy` is the OS user. It's still recorded, but its weaker provenance should show in the reason ("set by <user> (local)"), not pass as a GitHub-verified login.

**Post-merge** (not a precondition, but the same rule): with no CI adapter, base-branch CI is unknown, so postmerge returns `skipped`/`none`, revert is never automatic, and the dashboard should say so.

## Suggested order

1. **whoami seam.** Unblocks rules, notes and the existing `ci=skip` + `checks.commands` path.
2. **Base branch from git, and discover/sync accepting any remote or none.** Unblocks attach and build.
3. **facts() split.** Diff from git, trust from the tracker, CI from the adapter. `merge()` → `host.merge` with a local plain-git host.
4. **Local tracker with `getItem`, and trust.** Then move the SKILL.md gh steps behind F commands.
5. **Jenkins CI adapter.**
