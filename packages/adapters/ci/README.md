# CI providers

A CI provider says whether a commit's checks passed. The gate asks it before a merge (`facts()`, on the PR's head), and
`F postmerge` asks it about the merge commit on the base branch. A project's provider is `projects.json` `ci`, set by you
with `F project set <repo> ci <id>`. With none set, it is `github-actions` on a GitHub project and `local` on a `git` one.

| id | What it reads |
|---|---|
| `github-actions` | GitHub's checks: `gh pr checks` for a PR, `gh run list --commit` for a base-branch commit. GitHub projects only. |
| `local` | `F checks`: the `checks.commands` rule, run in the run's worktree. It passes only on the reviewed commit, with the same command list the rule has now, every exit 0. With no `checks.commands` rule it is `none`. It never checks the merge commit, so `F postmerge` says `skipped`, with why. |
| `none` | Nothing: always `none`. With the `ci` rule at `required` (the default) every merge escalates. |

From most to least checked: `github-actions`, `local`, `none`. Moving down that order relaxes what the factory checks, so
`F project set` needs `--reason`, and on a GitHub project a verified login (`gh auth login`).

The `ci` rule (`required|advisory|skip`) says how much the provider's answer counts: `required` needs `pass`; `advisory`
reports it without blocking; `skip` doesn't read it.

## Fail closed

A provider id that isn't in `builtin` (`index.ts`), `github-actions` on a project not on GitHub, a provider that throws, or
one that returns a state outside the five, each escalates the run, under every `ci` rule, `skip` included. `F postmerge`
reports `unknown` instead of `pass` or `skipped`. Nothing a provider can do reads as a pass by accident.

## Add one (Jenkins, GitLab CI, …)

Not shipped, because nobody here can test against a real server. To write one:

1. Copy `_template.ts` to `<id>.ts`. The file name, without its extension, must equal `export const id`.
2. Implement `checks(ctx, {repo, path, sha, changeRequest})`, returning `{state, url?, failed?, detail?}`:

| state | When |
|---|---|
| `pass` | every check on `sha` finished green |
| `fail` | any check finished red or was cancelled (`failed`: their names or URLs) |
| `pending` | some are still running |
| `none` | no checks for `sha` |
| `unknown` | it can't tell; or throw, which reads the same |

   Read only: never start, re-run or cancel a build. `ctx` has `gh`, `git` and `local(sha)`. For another server's API, shell
   out to its CLI or `curl` with a token the user set in their environment; never store credentials in `projects.json`.
   - **Jenkins**: find the build for `sha` through its REST API (`/job/<job>/api/json?tree=builds[result,building,url,actions[lastBuiltRevision[SHA1]]]`),
     or read the commit status Jenkins posts to the host. `building: true` is `pending`; `SUCCESS` is `pass`; anything
     else finished is `fail`.
3. Optionally, `logTail(ctx, {repo, path, sha})`: the failed checks' log on `sha` as text, `''` when there is none. `F ci RUN`
   shows its last 80 lines on a failure, so the build can fix it. `github-actions` gives `gh run view --log-failed` of the
   first failed run; `local` gives `F checks`' own output. Read only, like `checks`.
4. Add it to `builtin` in `index.ts`, one line. Core imports providers by name, so a broken file in this folder only fails
   `load()` and the contract test, never every command.
5. `node factory.mjs test` runs the shared `contract()` against every provider here, with stubbed `gh` and `git`.
   Give yours its own stub; never run it against a real server.
