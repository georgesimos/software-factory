# Claude Code platform features the factory uses

Sources (read 2026-11-22): code.claude.com/docs/en/{large-codebases, headless, deep-links, goal}. None of these features is marked beta. Version numbers are the minimums the docs state.

## Deep links: `claude-cli://open`
- `claude-cli://open?cwd=<absolute path>&q=<URL-encoded prompt>` opens a new terminal with Claude Code in `cwd`, with the prompt pre-filled. The prompt is **not sent** until the user presses Enter.
  - `q` is limited to 5,000 characters, with `%0A` for newlines.
  - `cwd` must be absolute. Paths with `..`, network/UNC paths and bidi or invisible characters are rejected.
  - `repo=owner/name` picks whichever clone or worktree was used most recently, so **use `cwd` for per-run worktrees**.
- There is **no resume or session-id parameter**. `claude --resume <id>` (which also accepts a `.jsonl` path) stays the way to resume.
- The handler is registered only after the user has sent a message in an interactive `claude` session (or started `claude agents` in a trusted folder). It can be turned off with `disableDeepLinkRegistration: "disable"`.
- GitHub Markdown strips the scheme. A local dashboard page can link it, or open it with `open` / `xdg-open`.
- Factory use: an "Open in Claude" link in the run detail (`cwd` = the run worktree, `q` = "Continue factory run <id>…"), next to "Copy resume".

## Headless: `claude -p`
- `--output-format json` returns `result`, `session_id`, `total_cost_usd`, `usage` and a per-model cost.
  - With `--json-schema '<schema>'`, the output also has `structured_output`. It is absent when the run produced no valid output, so check for it.
  - `stream-json --verbose --include-partial-messages` emits NDJSON events. Subagent messages carry `parent_tool_use_id`.
- `total_cost_usd` is the **whole conversation** total when used with `--resume`/`--continue`. Record the difference per step.
- Unattended runs: `--permission-mode auto --permission-prompts none` (v2.1.259+). From v2.1.302, `-p` defaults to Manual mode, which denies anything that would prompt.
- **Don't rely on `-p`'s current default: always say whether `--bare` is in use.** `--bare` skips skills, CLAUDE.md, hooks, MCP and plugins, and needs `ANTHROPIC_API_KEY` (no OAuth). The docs say it will become the default for `-p`.
- **Security:** without `--bare`, `-p` runs the repo's `.claude/settings.json` hooks and `.mcp.json` servers with **no trust prompt**. So `.claude/**` and `.mcp.json` are SENSITIVE paths, and the factory never runs `-p` inside an untrusted or imported checkout.
- Background work at exit:
  - `-p` waits up to 10 minutes for background tasks. Change this with `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, where 0 means no cap.
  - Raise `BASH_DEFAULT_TIMEOUT_MS` for long tests.
  - SIGTERM exits with code 143 and records no result. Send SIGINT first.
- `--max-budget-usd` stops the run, including background work, when the budget is reached.

## `/goal <condition>`
- One goal per session, at most 4,000 characters. After each turn, a small model judges the conversation: not met, met, or impossible. The judge **does not run commands**, so the condition must be something visible in the output.
- There is no turn cap, so write the bound into the condition ("…or stop after 20 turns").
- Works under `-p` (`claude -p "/goal …" --output-format stream-json --verbose`). The goal is restored on `--resume`.
- It is unavailable when `disableAllHooks` or `allowManagedHooksOnly` is set. The judge's tokens are billed on top.
- Factory use: the **build step**, with one goal per issue, e.g. "`pnpm test` exits 0, lint is clean, only files from the spec changed, or stop after 20 turns". It is **not** used for the review gate. The factory's own mechanical gate stays in charge, and the idea-to-app loop is still driven by `F`, one issue and one goal at a time.

## Large codebases
- `worktree.sparsePaths` and `worktree.symlinkDirectories: ["node_modules"]` apply to Claude Code's own `--worktree` and to subagent worktrees. It is not documented whether they apply to `git worktree add`, which is what `F` uses, so `F deps` stays.
- `permissions.deny` `Read(./**/dist/**/*)`-style rules keep reviewers out of generated and vendored code. Use `/**/*`, not `/**`. They do not cover subprocesses.
- `claudeMdExcludes` (globs) for monorepos. `--add-dir` together with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` for sibling repos.
- A `Stop` hook receives the transcript path. Later the factory could use it to propose CLAUDE.md or skill updates after a run, the "learning loop" gap from the earlier research.
