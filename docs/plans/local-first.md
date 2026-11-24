# Local-first, host- and CI-agnostic factory (plan)

Baseline: origin/main at dd398af (after #127). The inventory's line numbers are from 7f9bbab and are out of date.

What I read at dd398af:
- `core/src/github.ts`: `parseRun`, `intake`, `facts`, `merge`, `approval`, `approvalVote`, `postmerge`.
- `core/src/gate.ts`: `decide`, `risk`.
- `core/src/rules.ts`: `checkRules`, `whoami`, `LOGIN`.
- `core/src/constants.ts`: `TRUSTED`, `SENSITIVE`.
- `core/src/project.ts`: `REPO`, the host and tracker calls.
- `core/src/workspace.ts`: the base lookup.
- `server.ts`: `checkRepo`, the `autoMerge` export.
- `adapters/hosts/index.ts`, `adapters/trackers/index.ts`.
- Greps over `sync.ts`'s gh calls, every `autoMerge` read and write, and `.factory` uses (none in code; `architecture.md`
  §5 says no in-repo `.factory/` config was built).

`SKILL.md` and `sync.ts`'s logic below its gh calls I know only from the inventory.

Inputs:
- [`local-first-inventory.md`](local-first-inventory.md), the research behind this plan. Where it disagrees with the owner's decisions, the
  owner wins: no Jenkins or Bitbucket code, no work items stored in the state dir, no trusted-authors list.
- The owner's decisions:
  - Local work items are files in `.factory/issues/`.
  - When a run passes every gate, the factory opens a change request at the provider. Once it is approved there, the
    factory merges automatically or asks, set per project.
  - When there is no provider, or something can't be verified, the factory asks the user.
  - CI is pluggable: none or local checks, GitHub Actions, Jenkins.
  - The factory fails closed.
  - Auto-merge stays off by default.
  - Old config must still load, including GitHub `setBy`.
  - A local `setBy` counts for less than a verified host login.
  - Only GitHub and a git-only local provider get built. The rest are documented as plugins.

---

## 0. Open decisions (the owner should answer these before PR 7; PRs 1-6 don't depend on them)

**D1. The auto-merge default.** Every reader treats a missing key as on:
- `facts()` in `core/src/github.ts`: `projects()[repo]?.autoMerge !== false`;
- `server.ts`'s `autoMerge` export;
- `onboard.ts`;
- `apps/web Setup.tsx`.

The only writer is `F automerge` (`rules.ts setAutoMerge`). A project with no `autoMerge` key therefore auto-merges
today, which conflicts with "off by default". "Old config must still load" doesn't
settle it: the file still loads either way, and what changes is what a missing key means.
- **Recommendation:** add a per-project `merge: 'auto' | 'ask'`. A missing `merge` means `ask` for every project,
  including existing ones.
  - A legacy `autoMerge: true` maps to `merge: 'auto'`, and `autoMerge: false` maps to `ask`.
  - A missing `autoMerge` now means `ask`. That is the behaviour change.
  - `F sync` and `F onboard` print one line per affected project: "auto-merge is now off by default; `F automerge on
    owner/repo` keeps it".
  - Nothing in `projects.json` is rewritten without the user doing it. Failing closed means a run escalates that would
    have merged before, never the reverse.
- The alternative is to keep a missing key as on for projects attached before the change. That would need an attach date
  or migration marker that `projects.json` doesn't have, so I don't recommend it.

**D2. "Approved there" on GitHub.** The factory opens PRs as the user's own `gh` login, and GitHub won't let anyone approve
their own PR. A solo owner could therefore never approve a PR at the provider.
- **Recommendation:** a change request counts as approved when, after its head became `reviewedSha`, either of these
  happened:
  - a GitHub review in state `APPROVED` on that exact head commit, from a trusted association; or
  - a trusted `/factory approve` comment on the PR, the same vote rule as spec approval (`approvalVote()`).
- A stale approval, meaning one given on an earlier head, never counts.
- This changes GitHub's flow. Today the factory merges on a passing gate with no approval at the provider; after this, it
  waits for one. I read that as the owner's intent. If it isn't, GitHub's step 3 in §3 becomes optional per project.

**D3. Where `.factory/issues/` is read from.** The files live in the clone and anyone, or any agent, with write access can
edit them.
- **Recommendation:** at intake, read items from the project clone's local base branch, `refs/heads/<base>`, using
  `git show refs/heads/<base>:.factory/issues/<file>`. That is the user's own view.
  - Not `origin/<base>`, which run worktrees start from: that would hide items until the user pushes them.
  - Never a run's worktree.
- Intake snapshots the item into the event log as its title, its body and the blob sha. Nothing re-reads it during the
  run.
- **The factory never writes the items afterwards.**
  - "Done" lives in the event log, not the file: the local `markDone` is a no-op, and `listOpen` filters on the log.
  - `F item new` commits the new item on the local base and never pushes it.
- **The consequence the owner should accept:**
  - With a remote, the local base can hold unpushed item commits while the factory's merges land on `origin/<base>`.
  - After a merge, the `git` host fast-forwards the local base only when the local base is an ancestor of the result.
    Otherwise it leaves the base alone and says "your local <base> has N unpushed commits (items?): pull or rebase it".
  - The factory never rebases the user's branch.
- **The question for the owner:** should uncommitted items be picked up too? It's more convenient, but the source is
  weaker. If yes, intake reads the clone's working tree and marks the item "uncommitted", and a run from such an item
  never merges without asking.

**D4. Trust for local items.** A file has no verifiable author.
- **Recommendation:** every local item is `trust: 'untrusted'`. That means:
  - every spec needs approval through `F approve RUN` at a terminal or the desktop app's dialog (#21: approval never comes from the page; §2.2);
  - merge always asks, through `merge: 'ask'`, whatever the project's setting.
- With the git-only provider, nothing irreversible happens without the user's own terminal command. No trusted-authors
  list gets built. That was in the inventory, not in the owner's decisions.

**What a terminal approval can and can't override.** This is what makes §3 reachable for local items.
- `decide()` gets a third outcome, `await-approval`. It returns it when every reason it would escalate for is one of
  these **approvable** reasons:
  - the author isn't trusted, on a host with no verified identities (the `git` host);
  - merge is set to `ask`;
  - no change-request approval on `reviewedSha` yet.
- **Not approvable:** any other reason still escalates, and the user has to merge it by hand. These are: axes not passed;
  CI; the diff cap; sensitive paths; source changed without tests; the loop cap; the budget; no reviewed commit; the
  change-request head ≠ `reviewedSha`; `deploy.preview=required`; relaxing rules from an unverified login (§2.1).
- **One step.** On the `git` host, `F approve RUN --merge` (terminal or desktop dialog, never the page, §2.2) records `{by, via: 'local', sha: reviewedSha}`
  and then runs the merge in the same command.
  - The command re-runs `decide()` with that approval and merges only if the result is now `merge`.
  - An approval of another sha never counts.

---

## 1. Seams

The core never names GitHub. It talks to four provider families, each loaded from one file per provider through
`registry.ts loadDir()`: one `<id>.ts` per provider, a `_template.ts`, a README contract, and a shared `contract()` test.
Hosts and trackers already work this way; CI is new.

| Family | Folder | Built-in | Documented as a plugin |
|---|---|---|---|
| Host: repo, identity, change requests | `adapters/hosts/` | `github` (exists), `git` (new: git-only, local) | Bitbucket, GitLab, Gitea |
| Tracker: work items | `adapters/trackers/` | `github-issues` (exists), `local` (new: `.factory/issues/`) | Jira, Linear |
| CI | `adapters/ci/` (new) | `github-actions`, `local` (F checks), `none` | Jenkins |
| Harness | `adapters/harnesses/` | unchanged | unchanged |

### 1.1 Per-project selection (`projects.json`)

The `Project` type in `core/src/types.ts` gains these optional fields:
`{ host?: string; tracker?: string; ci?: string; base?: string; merge?: 'auto'|'ask' }`.
- **Old entries.** An existing entry with none of these fields loads as host `github`, tracker `github-issues` and CI
  `github-actions`, which is exactly what it does today. The `merge` default is D1.
- **New entries.** `F sync` (or attach) infers the host from `remote.origin.url`: `github.com` gives `github`; anything
  else, or no remote, gives `git`. The tracker and CI default to `local` and `none` for a `git` host. The user changes
  them with `F project set <repo> host|tracker|ci|base <id>`. That command validates the id against the loaded registry
  and writes an audit event like the one `F rules` writes.
- **Project id.** Keep `owner/repo`, so `parseRun`'s `/^([\w.-]+)\/([\w.-]+)#(\d+)$/` and every logged event still parse.
  - The owner part must also pass `project.ts REPO` and `server.ts checkRepo`, which use the GitHub-login shape
    `[A-Za-z0-9][A-Za-z0-9-]{0,38}`. So:
    - A clone whose remote isn't GitHub takes `owner/name` from its remote URL, parsed by the codex `slug()` rule for
      any form (scp, ssh, https, file).
    - Every character of the owner outside `[A-Za-z0-9-]` becomes `-`, and the result is trimmed to 39 characters. The
      name keeps `[\w.-]`.
    - A clone with no remote becomes `local/<folder>`, sanitised the same way.
  - The real remote URL is stored as `projects.json remote`.
  - **Collisions:** two clones that map to one id (two `local/app` folders, or the same owner/name on two hosts)
    aren't merged. Attaching refuses when the id already exists with a different path or remote: "<id> is already
    <path>: attach this one with --as <id>".
- **Run ids.** These stay `owner/repo#N`. A local item's id is its integer N, taken from the file name
  `.factory/issues/0007-<slug>.md`.
  - An imported change request keeps sharing the issue number space on GitHub, where `sync.ts` relies on that.
  - On the `git` host, an imported branch gets no N: imports there are not supported in v1 and are listed as a follow-up.

### 1.2 Host interface (extends `adapters/hosts/index.ts Host`)

`REQUIRED` stays `['authStatus','createRepo','pushInitial']`, so existing host plugins still load. The new functions are
optional. When the core needs one a host doesn't have, the run escalates with the reason
`host "<id>" cannot <verb>`, and the factory never falls back to another host.

```ts
whoami(ctx): { login: string; verified: boolean }            // github: gh api user (verified). git: OS user (unverified)
baseBranch(ctx, { repo, path }): string                      // git: refs/remotes/origin/HEAD → init.defaultBranch → projects.json base
openChangeRequest(ctx, { repo, path, branch, base, sha, title, body, closes? }): { id: string; url?: string }
changeRequest(ctx, { repo, path, id }): {
  state: 'open'|'merged'|'closed'|'unknown'; headSha: string|null;
  approval: { by: string; via: string; sha: string } | null;  // an approval on headSha only (D2)
  mergeSha?: string; mergedBy?: string }
listChangeRequests(ctx, { repo, path }): { base: string; open: { id; branch; headSha; title; url?; closes: string[] }[]; doneBranches: string[] }
                                                             // what sync and intake's clash check read (today's openPRs())
merge(ctx, { repo, path, id, sha, base }): { merged: boolean; sha?: string; detail?: string }
comment(ctx, { repo, id, body }): { posted: boolean }       // escalation notes; git: no-op, posted:false
publicUrl?: RegExp                                           // what server.ts scrub removes before the privacy checks
secretPatterns?: RegExp[]                                    // added to server.ts SECRET for the leak check
```

**`github`.** This is today's code moved behind the interface:
- `openChangeRequest`: `gh pr create`, which `SKILL.md` runs today.
- `listChangeRequests`: `openPRs()`.
- `changeRequest`: `gh pr view --json state,headRefOid,mergeCommit,mergedBy,reviews` plus the PR comments, judged by
  D2's rule. That `gh pr view` call is also sync's human-merge detection today.
- `merge`: `gh pr ready` then `gh pr merge --squash --delete-branch --match-head-commit <sha>`.
- `whoami`: `rules.ts whoami`.
- `baseBranch`: `gh repo view --json defaultBranchRef`.

**`git`.** No network is required; it uses the remote only when there is one.
- `whoami`: `{login: os.userInfo().username, verified: false}`. On a Windows machine that may be `DOMAIN\user`, which
  is allowed (§2.2).
- `openChangeRequest`: the change request is the branch `factory/issue-N` at `sha`. It is pushed if the project has a
  remote, otherwise left local. The record is `{id: 'factory/issue-N@<sha7>', url: undefined}`.
- `changeRequest`:
  - `headSha` is the branch's current head.
  - `approval` is the latest `F approve RUN --merge` event in the log, valid only while `headSha` equals the approved
    sha, with `via: 'local'`.
  - `state` is `merged` when the base branch contains the factory's own `mergeSha`, or contains `headSha` (a human's
    merge or fast-forward).
  - A human squash merge elsewhere (at a remote with a review UI) isn't detectable from git. The run stays escalated
    until the user runs `F close RUN --merged <sha>` at a terminal, which records `humanMerge` like #21's sync does and
    requires that `<sha>` is on the base.
- `listChangeRequests`: the local and remote `factory/*` branches not yet on the base, and `doneBranches` from
  `git branch --merged`. Squash merges are missed there too, as `sync.ts` already notes for GitHub.
- `merge`:
  1. Refuse unless the branch head equals `sha`.
  2. Fetch the base, if there is a remote.
  3. Squash `sha` onto the fresh base in a temp worktree.
  4. The squash commit `mergeSha` has the base sha seen as its parent. With a remote: a plain
     `git push <remote> <mergeSha>:refs/heads/<base>`. If the base moved, `mergeSha` no longer descends from it and the
     remote rejects the push as non-fast-forward. With no remote: `git update-ref refs/heads/<base> <mergeSha> <seen>`,
     which only succeeds if the ref still holds the sha seen.
  5. If the push or `update-ref` is rejected, return `merged: false`. That escalates and is never retried.
  - **Rule: no force flag ever touches a base branch.** No `--force`, `--force-with-lease` or `+refspec`. A test runs the
    merge against a moved base: the push is rejected and the remote's base is unchanged. A grep test asserts that
    `hosts/git.ts` contains no force flags.
  6. If the base is protected (a hosted remote with branch protection), the push is rejected. The escalation says
     "push to <base> refused: merge factory/issue-N at your host, then `F close RUN --merged <sha>`". This is the
     expected path for a remote whose reviews happen in its own UI.
- `comment`: `{posted: false}`. The escalation is in the dashboard and the run's events.

### 1.3 Tracker interface (extends `adapters/trackers/index.ts Tracker`)

`REQUIRED` is unchanged. The additions are optional, and a missing one escalates the same way as for hosts.

```ts
getItem(ctx, { repo, path, base, id }): {
  id; title; url?; author?: string; trust: 'trusted'|'untrusted'|'unknown';
  state: 'open'|'closed'; isChangeRequest: boolean; body; comments: { author; trusted: boolean; at; body }[] }
approval(ctx, { repo, id, since }): { decision: 'approve'|'reject'|'waiting'; by?: string; via: string }
markDone?(ctx, { repo, id }): void                       // github: relabelMerged (warn only). local: no-op, done is in the log (D3)
```

- **`github-issues`.** `intake()`'s `gh api repos/R/issues/N` and comment logic, plus `approval()` and `approvalVote()`
  from `github.ts`, move here. Trust is `TRUSTED.includes(author_association)`.
- **`local`.** Each item is markdown with front matter: `title`, `state`, `depends-on: [3, 5]`, and the acceptance list.
  - It is read per D3. `trust` is always `'untrusted'` (D4), and `comments` is `[]`.
  - `approval` reads `F approve RUN` events from the log.
  - `createIssues` writes and commits files. `listOpen` and `dependencies` read the front matter.
  - Ids are allocated as the highest N + 1, under a lock file in the state dir so two `F` processes never take the same N.

### 1.4 CI interface (new: `adapters/ci/`)

```ts
REQUIRED = ['checks']
checks(ctx, { repo, path, sha, changeRequest? }): { state: 'pass'|'fail'|'pending'|'none'|'unknown'; url?: string; failed?: string[]; detail?: string }
logTail?(ctx, { repo, sha }): string                     // for F ci RUN (replaces SKILL.md's gh run view --log-failed)
```

- **`github-actions`.** `facts()`'s `gh pr checks` bucket logic for a change request; `postmerge()`'s `gh run list
  --commit` for a merge sha.
- **`local`.** The `F checks` result on `sha`. It passes only when the run's `localChecks` has the same sha and the same
  command list as `checks.commands`, and every exit code is 0.
  - The check is `decide()`'s existing local-checks block, pulled out into a pure helper in `gate.ts`.
  - `decide()` keeps calling that helper, so its output and its tests don't change. The provider calls the same helper.
- **`none`.** Always `{state: 'none'}`.
- **Jenkins and others.** A plugin documented through the template only. It finds a build by commit through Jenkins'
  REST API or the build status Jenkins posts to the host. Not built, because nobody can test it.

The `ci` rule stays (`required|advisory|skip`), and its meaning is kept:
- `required`: the CI provider must return `pass`.
- `advisory`: the result is reported but doesn't block.
- `skip`: the provider isn't read.

`ci=skip` or `advisory` together with `checks.commands` still means "`F checks` stands in". With CI provider `local`,
`checks.commands` is what that provider runs, so a local project needs no relaxing rule to pass CI.

---

## 2. Identity: what "a local `setBy` is weaker" means

### 2.1 What the factory does

1. **Every write records its source.** Rule changes and notes record `{setBy, via}`, where `via` is the host id whose
   `whoami` produced the login (`github`, `git`, …), plus `verified: boolean`.
   - `rules.ts whoami()` calls the project's host `whoami`. If that throws or returns an empty login, it falls back to the
     `git` host's OS user with `verified: false`, and never fails because `gh` is missing.
   - This is the fix that unblocks rules and notes offline.
2. **Display.** An unverified source always shows as "set by <login> (local, unverified)" in `decide()` reasons, the
   rules list and the UI. It never displays like a verified login.
3. **The merge gate.** On a project whose host returns verified identities (GitHub), a rule that relaxes a merge
   condition counts only if it was set by a verified login. The relaxing rules are `ci=advisory`, `ci=skip`, and a
   `checks.commands` that replaces CI.
   - If a relaxing rule was set locally, `decide()` escalates with: "rule ci=skip was set by <login> (local, unverified):
     a verified login must set it for this project to merge on its own".
   - Rules that only tighten apply whoever set them. These are `diffCap` (it can only lower the cap), `ci=required` and
     `deploy.preview=required`.
4. **Projects on the git host.** These merge only by asking (D4), so a local `setBy` never leads to an unattended merge
   there either.
5. **What a local login never counts as.**
   - A trusted author.
   - A provider approval of a change request on a host that has verified approvals (D2).
   - A spec approval for an item from a tracker that has its own approval channel.
   - On GitHub, `F approve RUN` by an unverified local user is refused with "approve on the issue or PR".

### 2.2 Who may approve, and who may change a project's providers

On the `git` host, `F approve` takes GitHub's place as the trust anchor, so the run's own agent must never be able to use it.
Telling the agent not to (in the skill text) isn't enough.

1. **Refused inside a harness session.** `F approve` and `F approve --merge` refuse when any of these is set:
   - `FACTORY_CLAIM`;
   - any loaded harness's `current()` (e.g. `CLAUDE_CODE_SESSION_ID`, Codex's session variable);
   - `CLAUDECODE`.

   The refusal message is "approval must come from you, not from an agent session". It has a test for each variable.
2. **The terminal path also needs a TTY.** It prints the run, sha and diff stats, and makes the user type the first 7
   characters of the sha on `/dev/tty` (`CONIN$` on Windows). Agent tool calls run with no controlling terminal, so the
   prompt can't be answered there.
   - Limit: an agent can unset the environment variables in a subprocess, so step 1 is a speed bump, not a boundary.
     The TTY prompt and the desktop dialog are what it rests on.
   - `shortcut:` whether each harness's shell tool really has no TTY gets checked per harness (claude-code, codex)
     in PR 5b, before that PR relies on it.
3. **The desktop app path** (the owner works in the app). This is the main approval path; the terminal is the second.
   - The Electron main process adds an app-menu item, **Run → Approve…**. It lists the runs awaiting approval, read
     through core directly.
   - Picking one opens a native `dialog.showMessageBox` naming the run, its title, the sha, the diff stats and what
     the approval does ("approve the spec" / "approve and merge"). Cancel is the default button.
   - On confirm, main writes the same approve event as the CLI, with `{by: OS user, via: 'desktop', verified: false}`.
   - Nothing the page or HTTP can reach opens this dialog: no IPC channel, no preload function, no server route. The
     menu and the dialog belong to main alone.
   - The page shows "Approve from the app menu (Run → Approve…) or run `F approve RUN`" and nothing more.
   - Tests: an e2e run checks that the renderer has no approve function in its preload or IPC; a unit test covers the
     event main writes, with the dialog stubbed.
4. **Changing a project's providers is human-only.** `F project set <repo> host|tracker|ci|merge|base`:
   - follows the same session refusal as step 1;
   - is CLI or desktop menu only: the page and HTTP can't do it;
   - is audited like rules: an event with `{by, via, from, to, reason}`.
   
   Switching a verified host (github) to `git`, or `merge` to `auto`, or `ci` to `none`, counts as relaxing: it needs
   `--reason` and is shown as "(local, unverified)" when the changer's login is local.

### 2.3 Privacy

None of the following may ever reach a published page, an artifact or a shared payload:
- the OS username, including `DOMAIN\user`;
- remote hostnames and URLs from non-GitHub remotes;
- `local/<folder>` project ids;
- clone paths.

The existing publish scrub (`server.ts`) gains these patterns from the host (`publicUrl`) and from the identity seam. A
`local/` id is replaced with "a local project". A test builds a published page from a run with each of these values and
asserts none of them appears in the output.

### 2.4 Old config still loads (`rules.ts checkRules`)

`RULE_FIELDS` gains an optional `via`, and the check on `setBy` becomes:
- **No `via` (every existing rule):** `setBy` must match today's `LOGIN`, and the rule is treated as `via: 'github',
  verified: true`. Every existing `skills.json` validates unchanged.
- **`via: 'local'` or another unverified host:** `setBy` is any string of 1-100 characters without control characters,
  which covers `DOMAIN\user` and email addresses.
- **`via` set to a verified host:** that host's own shape check. For GitHub this is `LOGIN`.

A hand-edited legacy rule that only claims to be from GitHub was already possible before this change, so this neither
fixes nor widens that hole.

---

## 3. Merge flow: one path, with the provider plugged in

```
decide() → escalate: any non-approvable reason (§0, D4)   → the user merges by hand, or F close RUN --merged
         → await-approval / merge
  → host.openChangeRequest (GitHub: already a draft PR from build; mark it ready. git: the branch)
  → approval on reviewedSha:
      GitHub: a review or trusted /factory approve on the PR (D2)
      git:    F approve RUN --merge at a terminal, which is also the merge step
  → merge mode: auto → host.merge(sha = reviewedSha)
                ask  → awaiting-approval "approved at <host>; merge is set to ask" until F approve RUN --merge
                       (GitHub: by a verified login only)
  → tracker.markDone, CI checks on the merge sha (postmerge)
```

- `decide()` stays a pure function of the run plus `Facts`. `Facts` gains `{approval, mergeMode, hostVerified}` and
  loses nothing.
- `facts()` changes in three ways:
  - Diff and files come from git on the clone, with `git diff --numstat <base>...<reviewedSha>`, for the `git` host.
    GitHub keeps `gh pr view` in this design, and additionally escalates if the PR head isn't `reviewedSha`.
    Switching GitHub to git as well is a later, separate change.
  - Trust comes from `tracker.getItem().trust`.
  - CI comes from the CI provider.
- `merge()` in `github.ts` becomes `host.merge`. The CAS stays: `--match-head-commit` on GitHub, branch head plus lease
  on git.
- **Post-merge.**
  - With CI `none`, `postmerge()` returns `state: 'none'` and never auto-reverts, and the dashboard says "base CI not
    watched".
  - A revert on the `git` host leaves a `factory/revert-N` branch and escalates. It never pushes to the base on its own.

---

## 4. Fail closed: per seam

The rule: a provider call that throws, returns `unknown`, or isn't implemented stops the step. For a merge it escalates
with a named reason; for the earlier steps it refuses to start. Nothing gets retried around, and nothing gets skipped.

| Call | Throws / unknown / missing → |
|---|---|
| `host.whoami` | Fall back to the OS user with `verified: false` (§2.1). That is not a failure, but it is weaker everywhere it counts. |
| `host.baseBranch` | Fall back to `projects.json base`. If that is missing too, the build refuses: "cannot tell the base branch: set it with F project set <repo> base <branch>". |
| `tracker.getItem` | Intake refuses and the run doesn't start: "cannot read item N from tracker <id>: <detail>". |
| `getItem().trust` `unknown` | Treated as untrusted: the spec needs approval and the merge escalates. |
| `getItem().state` not `open`, or `isChangeRequest` | `notAnIssue`, as today. |
| `host.openChangeRequest` | Escalate: "could not open a change request at <host>". |
| `host.changeRequest` `unknown`, or `headSha ≠ reviewedSha` | Escalate: "change request head is <x>, not the reviewed commit <y>" / "change request state unknown". |
| No approval on `reviewedSha` | Wait. The run is `awaiting-approval`; it neither merges nor escalates as a failure. |
| `ci.checks` `fail` / `pending` / `none` / `unknown` under `ci=required` | Escalate: `CI checks are "<state>" (<ci provider>)`. `none` from the `none` provider says "no CI provider: set ci=local with checks.commands, or approve the merge yourself". |
| `ci.checks` throws | Escalate: "CI provider <id> failed: <detail>". This replaces today's uncaught throw in `facts()`. |
| `host.merge` `merged: false` / lease rejected / push rejected (branch protection, required reviews) | Escalate with the host's detail. Never retried, force-pushed or merged around. |
| `tracker.markDone`, `host.comment` | Warn only: they're cosmetic (today's `relabelMerged` rule). |
| Optional function missing | Escalate: `host "<id>" cannot <verb>`. |
| `.factory/**` in a run's diff | Already sensitive under `SENSITIVE`, extended by one alternative, `(^|\/)\.factory\/`, so the merge escalates. A run can't edit its own item or the queue. |

---

## 5. What always asks the user

These need a human whatever the configuration, because nothing local can verify them.

1. **Author trust for local items (D4).** Every local spec needs `F approve RUN`.
2. **Every merge on the `git` host.** `merge: 'ask'` is forced.
3. **Change-request approval** (D2) on any host.
4. **Host-side merge rules** (branch protection, required reviewers). They're invisible locally, so a rejected push
   escalates.
5. **"Someone else is already on it."** The `git` host can't know this. Before merging, the factory re-checks that the
   base is still what it built on; if the base moved, it rebuilds or escalates.
6. **`ci=required` with no CI provider that can say `pass`.**
7. **`deploy.preview=required` with no deploy connector.** This already escalates.
8. **Relaxing rules set by an unverified login** on a verified host (§2.1 step 3).
9. **Unknown project config.** An unknown host, tracker or CI id in `projects.json` refuses to load that project, with
   the list of loaded ids. It never falls back to `github`.

---

## 6. PR sequence

Every PR:
- stays at about 800 lines or fewer;
- has tests that run with `gh` absent (`FACTORY_GH` pointed at a missing binary);
- leaves the existing tests green unchanged under the `gh` stubs, which is the check that GitHub behaviour is the same.

The "move" PRs (3, 4a, 5a) are behaviour-identical on GitHub: code moves behind an interface, and new local code comes
in a separate PR. The sizes are guesses, not measurements.

Only two PRs change GitHub behaviour, and both say so in their PR body:
- **PR 5b:** `.factory/` becomes sensitive. No repo the factory runs on uses `.factory/` today, but a GitHub PR that
  touches it will now escalate.
- **PR 7:** D1, D2, and an explicit "change-request head ≠ reviewedSha" escalation. Today `--match-head-commit` makes
  the merge itself fail in that case.

1. **Identity seam.** (~300 lines)
   - `Host.whoami` (github, git).
   - `rules.ts`: the `via` field, the legacy load, the "(local, unverified)" display, and the §2.1 step 3 gate in
     `decide()`.
   - `F note` and `F rules` work without `gh`.
   - Tests: an old `skills.json` loads unchanged; a local rule relaxing CI escalates on a GitHub project.
   - Acceptance: the privacy test (§2.3) for the OS username, including `DOMAIN\user`.
2. **Project config and repo identity.** (~500 lines)
   - The `projects.json` fields (§1.1) with legacy inference, owner sanitising, the collision refusal, and
     `F project set` (human-only and audited, §2.2 step 4).
   - Acceptance: the privacy test (§2.3) for remote hostnames, `local/<folder>` ids and clone paths.
   - `discover()` accepts any remote or none. `sync` attaches a `git`-host project without calling `gh`; for those
     projects it skips the change-request import until 4b.
   - `sync.ts`'s session match uses the real origin URL.
   - The base branch through `host.baseBranch`, used by `workspace.ts worktree()` and `revert()`.
   - Copy: "git clones" (Setup, ProjectPicker).
3. **CI family, a move plus `none`/`local`.** (~500 lines)
   - `adapters/ci/` registry, template, README, `contract()`, `github-actions`, `local`, `none`.
   - `facts()` and `postmerge()` call the provider.
   - The local-checks helper is pulled out, and `decide()` keeps calling it.
   - `F ci RUN [--watch]`.
4a. **GitHub host, a move.** (~400 lines)
   - `openChangeRequest`, `listChangeRequests`, `changeRequest`, `merge` and `comment` on `hosts/github.ts`, moved out of
     `github.ts` and `sync.ts`.
   - `publicUrl` and `secretPatterns` feed `server.ts`.
   - `RunDetail` links come from the event's `url`.
4b. **`git` host change requests.** (~500 lines)
   - The branch change request, the CAS merge, protected-base handling, `F close RUN --merged`, and sync for `git`
     projects.
   - A temp-repo contract test: a moved base makes the plain push fail as non-fast-forward and leaves the remote unchanged; no-remote `update-ref` CAS; no force flag anywhere (§1.2).
5a. **`facts()` split and the GitHub tracker, a move.** (~400 lines)
   - `github-issues.getItem` and `approval` take over intake's and approval's gh calls.
   - `intake()` and `facts()` read trust through the tracker.
   - On the `git` host, diff and files come from git.
5b. **Local tracker.** (~600 lines)
   - `trackers/local.ts` (D3, D4).
   - `.factory/` added to `SENSITIVE`.
   - `F item new`, and `F approve RUN` for specs: refused inside a harness session, behind the TTY prompt, and refused for a verified host's items (§2.2). Tests for each refusal.
5c. **Desktop approval.** (~300 lines)
   - The Electron main-process menu item and native dialog (§2.2 step 3). It writes the same approve event, and the page and HTTP can't reach it.
6. **SKILL.md stops naming gh.** (~300 lines)
   - New commands: `F label`, `F split` (→ `tracker.createIssues`), `F escalate RUN` (→ `host.comment`), `F pr RUN`
     (→ `openChangeRequest`).
   - The skill text uses only these commands.
7. **Merge flow (§3) with D1 and D2.** (~500 lines)
   - `decide()`'s `await-approval`, `merge: auto|ask`, `F approve RUN --merge` (CLI and desktop dialog), and the approval wait.
   - The one-line notice.
   - The explicit head ≠ `reviewedSha` escalation.
   - It lands last, and only once D1 and D2 are answered.
8. **Docs only.** A plugin guide for hosts, trackers and CI: how to write Bitbucket, GitLab, Jenkins or Jira as one file
   each against the contract tests, and why the factory doesn't ship them (nobody can test them).

Order: 1 first. Then 2 and 3 in either order. Then 4a → 4b → 5a → 5b → 5c → 6 → 7, with 8 at any point.

A Windows machine with no GitHub access can run end to end, with the user approving each merge, after 5b. Before
7 that path is `F approve` for specs plus a manual merge.

## 7. Not in scope

- Building Jenkins, Bitbucket, GitLab or Jira adapters.
- Importing in-flight branches on the `git` host.
- Switching GitHub's diff to git.
- A trusted-authors list.
- Approving anything from the page (#21).
