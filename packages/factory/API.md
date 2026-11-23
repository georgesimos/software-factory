# Factory local API

`F ui [port]` serves the dashboard and a JSON API on `127.0.0.1` (`F` is `node <skill folder>/factory.mjs`: `~/.claude/skills/software-factory` for a linked install, or the plugin's `packages/factory`). It prints one URL:

```
factory ui: http://127.0.0.1:<port>/?t=<token>
```

The token is random per launch and lives only in that process. Anyone with it can change the factory's settings, so don't share the URL.

Each route calls the same validated function as its CLI command; there is no second code path. No route approves, merges, writes notes, or loosens rules, trust or the merge gate.

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
| `GET /api/state` | everything the dashboard embeds: `runs`, `metrics`, `projects`, `rules`, `ruleHistory`, `skills`, `harnesses`, `hooks`, `onboard`, `autoMerge`, `ideas`, `generated`, `cap`, `costCap`, `tokenCap`, and `resumable` (runs whose session here stopped or crashed, which `POST /api/sessions` would resume) | – | nearest: `F state`, `F rules`, `F skills` |
| `GET /api/runs/:owner/:repo/:n` | `{"run": run}` for `owner/repo#n` | `400` malformed owner, repo or number; `404` no such run | nearest: `F state owner/repo#n` (without archived runs, sessions or worktree) |
| `GET /api/metrics?project=&since=` | token burn and outcomes derived from the event log (#82): `total` and `byDay`, `byProject`, `byStage`, `byAxis`, `byModel`, `byHarness` cells (`tokens`, `input`, `output`, `cacheRead`, `cacheWrite`, `costUsd` or `null` when no model was priced, `unpriced` tokens, `reported` tokens and `source`: measured, reported or mixed), `cacheHitRatio`, `outcomes` (merged, escalated, rejected, reverted), `costPerMergedPrUsd`, `loopsPerRun`, `capHitShare`, `medianIntakeToMergeMs`, `measuredRuns`. `project` is `owner/repo`; `since` is an ISO date, and burn rows and outcomes count by their own time | `400` unparseable `since` | nearest: `F usage` |

None of them returns the `F ui` token.

`GET /?t=<token>` serves the dashboard (`packages/factory/app.html`, the single-file build of apps/web) with no data in it: the page reads `GET /api/state` and writes through the routes below. `/app/` and `/app`, the preview URLs before #55, redirect to `/`.

## Writes

Every write is also served at its original path without `/api` (for example `POST /skills`), which the dashboard uses.

| Route | Body | Returns | CLI |
|---|---|---|---|
| `POST /api/skills` | `{"scope": "owner/repo"\|"default", "step": "<step>", "runner": {…}\|null}` (`null` unsets) | the Skills sheet data (runners with `model`, `effort`, `fallback`, plus `models`, `efforts`, `preset` and `presets`) | `F skills set\|unset` |
| `POST /api/skills/preset` | `{"name": "all-claude"\|"all-claude-lean", "scope"?: "owner/repo"\|"default"}` | the Skills sheet data plus `applied`, `skipped` and `inherited` step lists (a project only gets the preset on steps it already sets) | `F skills preset <name> [scope]` |
| `POST /api/idea` | `{"repo": "owner/repo", "idea": "…", "stack": "<id>"}` | `{"run", "next"}`; records the idea only | `F new "<idea>" --name owner/repo --stack <id>` |
| `POST /api/onboard` | `{}` | setup state (harnesses, logins, repos, runners, rules); reads only | `F onboard --json` |
| `POST /api/onboard/sync` | `{"repo": "owner/repo", "path": "<absolute clone path>"}` | onboarding config | `F sync owner/repo <path>` |
| `POST /api/onboard/ship` | `{"scope": "owner/repo"\|"default", "ship": ["web","mobile","database"]}` | onboarding config | `F onboard ship <scope> <kinds>` |
| `POST /api/onboard/rule` | `{"scope", "key", "value", "reason", "until"?}` or `{"scope", "key", "unset": true, "reason"?}` | onboarding config | `F rules set\|unset` |
| `POST /api/onboard/automerge` | `{"repo": "owner/repo", "on": true\|false}` | onboarding config | `F automerge owner/repo on\|off` |

`/api/onboard` is a `POST` although it only reads, because it checks logins by running local CLIs.
