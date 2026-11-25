# Factory local API

`F ui [port]` serves the dashboard and a JSON API on `127.0.0.1` (`F` is `node <skill folder>/factory.mjs`: `~/.claude/skills/software-factory` for a linked install, or the plugin's `packages/factory`). It prints one URL:

```
factory ui: http://127.0.0.1:<port>/?t=<token>
```

The token is random per launch and lives only in that process. Anyone with it can change the factory's settings, so don't share the URL.

Each route calls the same validated function as its CLI command; there is no second code path. No route approves, merges, or loosens rules, trust or the merge gate. One route does, deliberately: `POST /api/onboard/rule` with `steps.off` turns optional review steps off for one project. It only requests the change: the desktop app's main process confirms it in its own dialog, built from F's reading of the change, and writes it. Without the desktop app it refuses and names the CLI command. Like `F rules set`, it needs a reason and is audited, a local user can't undo a verified login's choice, and it is refused when F runs inside an agent session. Raising a run cap (`run.loops`, `run.budgetUsd`, or unsetting one) goes the same way; lowering one is written straight away. One route writes a note, `POST /api/note`: #17 added it on purpose for the run detail's "Note for next step" box, which supersedes #22's "notes stay human-only". A note steers the next step's brief; it never moves the gate.

## Auth

Every `/api/*` request needs:

| Check | Reads (`GET`) | Writes (`POST`) |
|---|---|---|
| `Host` is `127.0.0.1:<port>` or `localhost:<port>` | required | required |
| `x-factory-token: <token>` | required | required |
| `Origin` is `http://127.0.0.1:<port>` or `http://localhost:<port>` | a foreign one is refused; a missing one is accepted, since browsers omit it on same-origin GETs | required |
| `Content-Type: application/json`, body a JSON object | – | required |

Errors are JSON `{"error": "…"}`: `403` for Host, token or Origin, `415` for the content type, `400` for invalid input, `404` for an unknown route.

```bash
T=<token>; P=<port>
curl -s -H "x-factory-token: $T" http://127.0.0.1:$P/api/runs
curl -s -X POST -H "x-factory-token: $T" -H "Origin: http://127.0.0.1:$P" -H 'Content-Type: application/json' \
  -d '{"repo":"acme/app","on":false}' http://127.0.0.1:$P/api/onboard/automerge
```

## Reads

| Route | Returns | Errors | CLI |
|---|---|---|---|
| `GET /api/runs` | `{"runs": [run…]}`: the run list `dashboard.html` embeds (live and archived runs, newest first, with linked sessions and worktree path) | – | nearest: `F state <run>` per run |
| `GET /api/state` | everything the dashboard embeds: `runs`, `metrics`, `projects`, `rules`, `ruleHistory`, `skills`, `harnesses`, `hooks`, `onboard`, `autoMerge`, `ideas`, `generated`, `cap`, `costCap`, `tokenCap`, and `resumable` (runs whose session here, or whose `F start`, stopped or crashed, held by no live claim, which `POST /api/sessions` would resume), and `terminal` (true in the desktop app, which supplies node-pty for terminal sessions) | – | nearest: `F state`, `F rules`, `F skills` |
| `GET /api/runs/:owner/:repo/:n` | `{"run": run}` for `owner/repo#n` | `400` malformed owner, repo or number; `404` no such run | nearest: `F state owner/repo#n` (without archived runs, sessions or worktree) |
| `GET /api/metrics?project=&since=` | token burn and outcomes derived from the event log (#82): `total` and `byDay`, `byProject`, `byStage`, `byAxis`, `byModel`, `byHarness` cells (`tokens`, `input`, `output`, `cacheRead`, `cacheWrite`, `costUsd` or `null` when no model was priced, `unpriced` tokens, `reported` tokens and `source`: measured, reported or mixed), `cacheHitRatio`, `outcomes` (merged: the factory's own merges; humanMerged, also counted in escalated; rejected, closed, split; reverted: of the factory's merges), `costPerMergedPrUsd`, `loopsPerRun`, `capHitShare` (unmerged runs stopped at the loop cap or budget, as recorded), `medianIntakeToMergeMs`, `measuredRuns`; `byAxis` is not a partition of `total`. `project` is `owner/repo`; `since` is an ISO date, and burn rows and outcomes count by their own time | `400` unparseable `since`; `500` with no internal detail | nearest: `F usage` |
| `GET /api/sessions` | `{"sessions": [{id, harness, mode, label, state, exit, started, ended, harnessSession}…]}`: the sessions this server started, oldest first | – | none |
| `GET /api/sessions/:id/events` | server-sent events (`output` for a terminal, `event` for headless and sdk, `error`, `exit`); `Last-Event-ID` resumes. Read it with `fetch`: `EventSource` can't send the token | `404` no such session | none |

None of them returns the `F ui` token.

`GET /?t=<token>` serves the dashboard (`packages/factory/app.html`, the single-file build of apps/web) with no data in it: the page reads `GET /api/state` and writes through the routes below. `/app/` and `/app`, the preview URLs before #55, redirect to `/`.

## Writes

Every write is also served at its original path without `/api` (for example `POST /skills`), which the dashboard uses.

| Route | Body | Returns | CLI |
|---|---|---|---|
| `POST /api/skills` | `{"scope": "owner/repo"\|"default", "step": "<step>", "runner": {…}\|null}` (`null` unsets) | the Skills sheet data (runners with `model`, `effort`, `fallback`, plus `models`, `efforts`, `preset` and `presets`) | `F skills set\|unset` |
| `POST /api/skills/preset` | `{"name": "all-claude"\|"all-claude-lean", "scope"?: "owner/repo"\|"default"}` | the Skills sheet data plus `applied`, `skipped` and `inherited` step lists (a project only gets the preset on steps it already sets) | `F skills preset <name> [scope]` |
| `POST /api/idea` | `{"repo": "owner/repo", "idea": "…", "stack": "<id>"}` | `{"run", "next"}`; records the idea only | `F new "<idea>" --name owner/repo --stack <id>` |
| `POST /api/note` | `{"run": "owner/repo#N", "text": "…"}` | `{"id", "step": "next", "text", "by"}` (plus `warning` when it may never be read); a one-shot note for whichever step starts next: 1–1000 characters, refused for unknown, imported and finished runs. `by` is `gh api user`, or with no gh login the OS user (then `via: "local"`). The page gets pending notes without `by`, and note events without their text | `F note owner/repo#N next -` |
| `POST /api/onboard` | `{}` | setup state (harnesses, logins, repos, runners, rules); reads only | `F onboard --json` |
| `POST /api/onboard/sync` | `{"repo": "owner/repo", "path": "<absolute clone path>"}` | onboarding config | `F sync owner/repo <path>` |
| `POST /api/onboard/ship` | `{"scope": "owner/repo"\|"default", "ship": ["web","mobile","desktop"]}` | onboarding config | `F onboard ship <scope> <kinds>` |
| `POST /api/onboard/rule` | `{"scope", "key", "value", "reason", "until"?}` or `{"scope", "key", "unset": true, "reason"?}` | onboarding config; for `steps.off` or a raised cap, `"requested"` too: nothing is written until you confirm the desktop app's dialog | `F rules set\|unset` |
| `POST /api/onboard/automerge` | `{"repo": "owner/repo", "on": true\|false}` | onboarding config | `F automerge owner/repo on\|off`. `on` is refused when `F ui` runs inside an agent session, without a verified gh login, or for a git project (it always asks). Off, the default, a GitHub run escalates and you merge its PR in GitHub |
| `POST /api/sessions` | `{"repo": "owner/repo", "issue": N, "harness"?, "mode"?: "headless"\|"sdk"}` | `{"session"}`; starts or resumes the factory run for that issue, with its budget. (Codex's own modes, for its sessions off a run: `headless`, `terminal`, `app-server` and `sdk`. Its `sdk` mode is read-only and never on a run: the SDK reports no pid for the claim, and a stop can't end the commands it started, so a write session runs as `app-server` or `headless`.) Only a harness that loads the factory skill and caps its spend drives a run (Claude Code): `"harness": "codex"` is refused, naming its step-runner and terminal uses instead. A resume on another harness than the one that ran the session is refused, so a session id never reaches the wrong CLI. Refuses active, escalated, rejected and archived runs. While a session of this app's runs on that run, refuses with `already has a running session in this app (<mode>, started <time>): stop it in Sessions first (POST /api/sessions/stop {"id":"…"})`, as a terminal on the run does | `/software-factory owner/repo#N` |
| `POST /api/runs` | `{"issue": "owner/repo#N"}` | `{"pid", "log"}`; the same checks as `POST /api/sessions`, then a detached headless run that outlives `F ui` and logs to the run's folder. It is not in `GET /api/sessions`, and quitting doesn't stop it. Every launcher (this, `POST /api/sessions`, a terminal on the run) first takes the run's `claim.json`, so a second one, in any process, is refused while the claim's process may live (unsure counts as live); a start after that process died resumes the harness session its log names. The refusal names the way out: `F unclaim owner/repo#N` once that pid is gone (CLI only; `--force` past a live-looking claim) | `F start owner/repo#N` |
| `POST /api/sessions/terminal` | `{"repo": "owner/repo", "issue"?: N, "resume"?: "<harness session id>", "harness"?}` | `{"session"}`; a person's own interactive harness in a pseudo-terminal, in the run's worktree or the clone; with `resume`, a session this app started, in that session's folder. Never counts as the run's session for a factory resume. Desktop app only (node-pty) | `claude [--resume <id>]` |
| `POST /api/sessions/input` | `{"id", "data"?: "<keys>", "cols"?, "rows"?}` | `{"ok"}`; keystrokes and size for a running terminal session | none |
| `POST /api/sessions/stop` | `{"id"}` | `{"ok"}`; stops it and its child processes (`taskkill /T` on Windows) | none |
| `POST /api/sessions/open` | `{"id": "<session id>", "harness"?}` | `{"opened"}`: opens it in the Claude desktop app, by its own `local_` id or the desktop id F recorded with that CLI session's events (`hostSessionId`, from `CLAUDE_CODE_HOST_SESSION_ID` only, inside a Claude Code session; the sessions F starts never inherit it, and the published artifact drops it). Otherwise `{"resume": {"command", "cwd"?}}`: how to resume a session started in a plain terminal. `400` for an id that isn't a plain session id Opening a desktop session is never refused (it adds no harness). The resume answer is refused with the claim's message while a launcher holds a live or unreadable claim on a run that session worked on (from its events, or this app's session label); a session with no recorded run can't be checked. | `F open <session id>` |

`/api/onboard` is a `POST` although it only reads, because it checks logins by running local CLIs.
